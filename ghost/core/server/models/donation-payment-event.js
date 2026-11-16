const errors = require('@tryghost/errors');
const ghostBookshelf = require('./base');
const { fitToColumns } = require('./base/utils');

const DonationPaymentEvent = ghostBookshelf.Model.extend(
  {
    tableName: 'donation_payment_events',

    onSaving: function onSaving() {
      ghostBookshelf.Model.prototype.onSaving.apply(this, arguments);
      // The donor's name comes from Stripe, which takes longer names than the column holds, and
      // the attribution from the visitor's browser, with no length limit. Stored in full, either
      // would fail the webhook recording the donation on every try, so it would never be recorded.
      fitToColumns(this, [
        'name',
        'attribution_url',
        'referrer_source',
        'referrer_medium',
        'referrer_url',
        'utm_source',
        'utm_medium',
        'utm_campaign',
        'utm_term',
        'utm_content',
      ]);
    },

    member() {
      return this.belongsTo('Member', 'member_id', 'id');
    },

    postAttribution() {
      return this.belongsTo('Post', 'attribution_id', 'id');
    },

    userAttribution() {
      return this.belongsTo('User', 'attribution_id', 'id');
    },

    tagAttribution() {
      return this.belongsTo('Tag', 'attribution_id', 'id');
    },
  },
  {
    async edit() {
      throw new errors.IncorrectUsageError({ message: 'Cannot edit DonationPaymentEvent' });
    },

    async destroy() {
      throw new errors.IncorrectUsageError({ message: 'Cannot destroy DonationPaymentEvent' });
    },
  },
);

module.exports = {
  DonationPaymentEvent: ghostBookshelf.model('DonationPaymentEvent', DonationPaymentEvent),
};
