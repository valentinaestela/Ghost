const errors = require('@tryghost/errors');
const logging = require('@tryghost/logging');
const StripeAPI = require('./stripe-api');

/**
 * @param {unknown} value
 * @returns {unknown}
 */
const stampIn = (value) =>
  value &&
  typeof value === 'object' &&
  'metadata' in value &&
  value.metadata &&
  typeof value.metadata === 'object'
    ? value.metadata[StripeAPI.SITE_METADATA_KEY]
    : undefined;

/**
 * The site stamp an event's object carries (see `StripeAPI.SITE_METADATA_KEY`): in its own
 * metadata for a checkout or subscription, or, for an invoice, in its subscription line's, as
 * Stripe gives a subscription line its subscription's metadata.
 *
 * @param {unknown} object
 * @returns {unknown}
 */
function siteStampOf(object) {
  const own = stampIn(object);
  if (own !== undefined || !object || typeof object !== 'object' || !('lines' in object)) {
    return own;
  }
  const lines =
    object.lines && typeof object.lines === 'object' && 'data' in object.lines
      ? object.lines.data
      : [];
  const subscriptionLine = Array.isArray(lines)
    ? lines.find(
        (line) =>
          line && typeof line === 'object' && 'type' in line && line.type === 'subscription',
      )
    : undefined;
  return stampIn(subscriptionLine);
}

/**
 * The classes of Stripe's errors for a key that no longer works on the publisher's Stripe
 * account: expired or revoked (`StripeAuthenticationError`), or stripped of the permissions Ghost
 * needs (`StripePermissionError`). Stripe's client puts the class's name in an error's `type`.
 */
const ACCOUNT_ACCESS_ERRORS = new Set(['StripeAuthenticationError', 'StripePermissionError']);

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isAccountAccessError(err) {
  return (
    typeof err === 'object' && err !== null && 'type' in err && ACCOUNT_ACCESS_ERRORS.has(err.type)
  );
}

module.exports = class WebhookController {
  /**
   * @param {object} deps
   * @param {import('./webhook-manager')} deps.webhookManager
   * @param {import('./services/webhook/checkout-session-event-service')} deps.checkoutSessionEventService
   * @param {import('./services/webhook/subscription-event-service')} deps.subscriptionEventService
   * @param {import('./services/webhook/invoice-event-service')} deps.invoiceEventService
   * @param {import('./services/webhook/charge-refunded-event-service')} deps.chargeRefundedEventService
   * @param {() => string | undefined} deps.getSiteUuid The uuid of this site, which Ghost stamps on
   *   each checkout and subscription it creates (see `StripeAPI.SITE_METADATA_KEY`).
   * @param {Pick<import('./tracking').StripeTracking, 'webhook'>} deps.tracking
   * @param {{captureException(err: unknown): unknown}} deps.sentry
   */
  constructor(deps) {
    this.getSiteUuid = deps.getSiteUuid;
    this.tracking = deps.tracking;
    this.sentry = deps.sentry;
    this.checkoutSessionEventService = deps.checkoutSessionEventService;
    this.subscriptionEventService = deps.subscriptionEventService;
    this.invoiceEventService = deps.invoiceEventService;
    this.chargeRefundedEventService = deps.chargeRefundedEventService;
    this.webhookManager = deps.webhookManager;
    this.handlers = {
      'customer.subscription.deleted': this.subscriptionEvent,
      'customer.subscription.updated': this.subscriptionEvent,
      'customer.subscription.created': this.subscriptionEvent,
      'invoice.payment_succeeded': this.invoiceEvent,
      'checkout.session.completed': this.checkoutSessionEvent,
      'checkout.session.async_payment_succeeded': this.checkoutSessionEvent,
      'checkout.session.async_payment_failed': this.checkoutSessionEvent,
      'charge.refunded': this.chargeRefundedEvent,
    };
  }

  /**
   * @param {object} config
   * @param {string[]} config.webhookCustomerIgnoreList
   */
  configure({ webhookCustomerIgnoreList = [] }) {
    this.webhookCustomerIgnoreSet = new Set(webhookCustomerIgnoreList.filter(Boolean));
  }

  /**
   * @param {import('stripe').Stripe.Event} event
   * @returns {string | null}
   */
  getEventCustomerId(event) {
    const customer = event?.data?.object?.customer;
    if (typeof customer === 'string') {
      return customer;
    }

    if (customer && typeof customer.id === 'string') {
      return customer.id;
    }

    return null;
  }

  /**
   * Whether the event is about a checkout or subscription another site created, or an invoice for
   * one of its subscriptions. Stripe sends every site connected to the same Stripe account each
   * event on the account, and Ghost stamps each checkout and subscription it creates with its
   * site's uuid. Handling another site's would make its buyer a member here, or fail on every try
   * and leave Stripe telling the publisher the webhook is failing, while that site handles the
   * event itself. An unstamped object, created before Ghost stamped them or outside Ghost, such as
   * through a Stripe payment link, isn't another site's as far as Ghost can tell.
   *
   * @param {import('stripe').Stripe.Event} event
   * @returns {boolean}
   */
  createdByAnotherSite(event) {
    const siteUuid = this.getSiteUuid();
    const stamp = siteStampOf(event.data?.object);
    return Boolean(siteUuid) && typeof stamp === 'string' && stamp !== siteUuid;
  }

  /**
   * @param {import('stripe').Stripe.Event} event
   * @returns {boolean}
   */
  shouldIgnoreEvent(event, customerId) {
    if (event.type !== 'customer.subscription.updated') {
      return false;
    }

    return (
      typeof customerId === 'string' && this.webhookCustomerIgnoreSet?.has(customerId) === true
    );
  }

  /**
   * Handles a Stripe webhook event.
   * - Parses the webhook event
   * - Delegates the event to the appropriate handler
   * - Returns a 200 response to Stripe to confirm receipt of the event, or an error response if the event is not handled or if an error occurs
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @returns {Promise<void>}
   */
  async handle(req, res) {
    if (!req.body || !req.headers['stripe-signature']) {
      res.writeHead(400);
      return res.end();
    }
    try {
      await this.tracking.webhook(async (attempt) => {
        let event;
        try {
          event = this.webhookManager.parseWebhook(req.body, req.headers['stripe-signature']);
        } catch (err) {
          throw new errors.UnauthorizedError({
            err,
            message: "The webhook's signature doesn't show that Stripe sent it to this site.",
          });
        }
        attempt.receiving(event.type);

        // Stripe shapes each event for the API version of the URL it was sent to. A different
        // version means this event did not come through the URL Ghost registered, and fields
        // may not be where Ghost reads them.
        if (event.api_version !== StripeAPI.API_VERSION) {
          logging.error(
            {
              event: { name: 'stripe.webhook.api_version_mismatch' },
              stripe_event_type: event.type,
              api_version: event.api_version,
              expected_api_version: StripeAPI.API_VERSION,
            },
            'Stripe sent a webhook rendered at a different API version than Ghost expects',
          );
        }

        if (this.createdByAnotherSite(event)) {
          attempt.ignoring('another_site');
          logging.info(
            {
              event: { name: 'stripe.webhook.another_site' },
              stripe_event_type: event.type,
              stripe_event_id: event.id,
            },
            'Ignored a Stripe webhook about a checkout or subscription another site created',
          );
          return;
        }

        const customerId = this.getEventCustomerId(event);
        if (this.shouldIgnoreEvent(event, customerId)) {
          attempt.ignoring('listed_customer');
          logging.info(
            {
              event: { name: 'stripe.webhook.ignored' },
              stripe_event_type: event.type,
              customer_id: customerId,
            },
            'Ignored a Stripe webhook for a customer on stripeWebhookCustomerIgnoreList',
          );
          return;
        }

        logging.info(
          {
            event: { name: 'stripe.webhook.received' },
            stripe_event_type: event.type,
            stripe_event_id: event.id,
          },
          'Handling a Stripe webhook',
        );

        await this.handleEvent(event);
      });
      res.writeHead(200);
      res.end();
    } catch (err) {
      // The span has logged the error. Sentry keeps only the unexpected ones: Ghost's setup drops
      // every Ghost error whose status isn't 500, and keeps every other error, Stripe's included.
      // A publisher who revoked Ghost's access to their Stripe account fails every event Stripe
      // sends until they reconnect, which only they can do, so those errors aren't sent at all.
      // Stripe sends the event again later.
      if (!isAccountAccessError(err)) {
        this.sentry.captureException(err);
      }
      res.writeHead(err?.statusCode || 500);
      res.end();
    }
  }

  /**
   * Accepts a webhook's event payload and delegates it to the appropriate handler based on the event type
   * @private
   * @param {import('stripe').Stripe.Event} event
   * @returns {Promise<void>}
   */
  async handleEvent(event) {
    if (!this.handlers[event.type]) {
      return;
    }

    await this.handlers[event.type].call(this, event.data.object, event.type);
  }

  /**
   * Delegates any `customer.subscription.*` events to the `subscriptionEventService`
   * @param {import('stripe').Stripe.Subscription} subscription
   * @private
   */
  async subscriptionEvent(subscription) {
    await this.subscriptionEventService.handleSubscriptionEvent(subscription);
  }

  /**
   * Delegates any `invoice.*` events to the `invoiceEventService`
   * @param {import('stripe').Stripe.Invoice} invoice
   * @private
   */
  async invoiceEvent(invoice) {
    await this.invoiceEventService.handleInvoiceEvent(invoice);
  }

  /**
   * Delegates any `checkout.session.*` events to the `checkoutSessionEventService`
   * @param {import('stripe').Stripe.Checkout.Session} session
   * @param {import('stripe').Stripe.Event.Type} eventType
   * @private
   */
  async checkoutSessionEvent(session, eventType) {
    await this.checkoutSessionEventService.handleEvent(session, eventType);
  }

  /**
   * Delegates `charge.refunded` events to the `chargeRefundedEventService`
   * @param {import('stripe').Stripe.Charge} charge
   * @private
   */
  async chargeRefundedEvent(charge) {
    await this.chargeRefundedEventService.handleEvent(charge);
  }
};
