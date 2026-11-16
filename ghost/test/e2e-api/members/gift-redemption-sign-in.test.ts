import assert from 'node:assert/strict';

const { agentProvider, fixtureManager, mockManager } = require('../../utils/e2e-framework');
const DomainEvents = require('@tryghost/domain-events/lib/DomainEvents');
const models = require('../../../core/server/models');
const urlUtils = require('../../../core/shared/url-utils').default;

interface MembersAgent {
  get: (_url: string) => any;
  post: (_url: string) => any;
  duplicate: () => MembersAgent;
}

interface SentMail {
  to: string;
  subject: string;
  text: string;
}

// Tests the magic link that Portal requests for a gift whose tier has requirements, such as a
// shipping address. The link signs the visitor in, creating the member if they are new, and
// redirects back to the gift without redeeming it. The member then redeems the gift through the
// same endpoint as any signed-in member. Driven through the members API, the way Portal calls it.
describe('Magic link for a gift with tier requirements', function () {
  let membersAgent: MembersAgent;
  let paidTierId: string;
  let sequence = 0;
  let sent: () => SentMail[];

  /** Creates a purchased gift of the paid tier and returns its token. */
  async function purchasedGift(overrides: Record<string, unknown> = {}): Promise<string> {
    sequence += 1;
    const token = `gift-sign-in-${Date.now()}-${sequence}`;
    const now = new Date();
    const expiresAt = new Date(now);
    expiresAt.setFullYear(expiresAt.getFullYear() + 1);
    await models.Gift.add({
      token,
      buyer_email: `gift-buyer-${sequence}@example.com`,
      buyer_member_id: null,
      redeemer_member_id: null,
      tier_id: paidTierId,
      cadence: 'year',
      duration: 1,
      currency: 'usd',
      amount: 5000,
      stripe_checkout_session_id: `cs_gift_sign_in_${Date.now()}_${sequence}`,
      stripe_payment_intent_id: `pi_gift_sign_in_${Date.now()}_${sequence}`,
      checkout_started_at: now,
      consumes_at: null,
      expires_at: expiresAt,
      status: 'purchased',
      purchased_at: now,
      redeemed_at: null,
      consumed_at: null,
      expired_at: null,
      refunded_at: null,
      ...overrides,
    });
    return token;
  }

  /** The gift's redemption URL in Portal, which the magic link redirects back to. */
  function redemptionUrl(token: string): string {
    const url = new URL(urlUtils.getSiteUrl());
    url.hash = `#/portal/gift/redeem/${token}`;
    return url.href;
  }

  /**
   * Requests the magic link the way Portal does for a gift with requirements, and expects the
   * response to have `status`.
   */
  async function requestLink(agent: MembersAgent, email: string, token: string, status = 201) {
    const { text: integrityToken } = await agent.get('/api/integrity-token/').expectStatus(200);
    return agent
      .post('/api/send-magic-link/')
      .body({
        email,
        name: 'Gift Receiver',
        emailType: 'subscribe',
        integrityToken,
        giftToRedeem: token,
        redirect: redemptionUrl(token),
      })
      .expectStatus(status);
  }

  /** Opens the magic link emailed to this address and returns the URL it redirects to. */
  async function followLink(agent: MembersAgent, email: string): Promise<URL> {
    const mail = sent().find(({ to }) => to === email);
    assert.ok(mail, `expected an email to ${email}`);
    const [link] = mail.text.match(/https?:\/\/[^\s]+/) ?? [];
    assert.ok(link, 'expected a link in the email');
    const res = await agent
      .get(`/${new URL(link).search}`)
      .expectStatus(302)
      .expectHeader('Set-Cookie', /members-ssr.*/);
    return new URL(res.headers.location, urlUtils.getSiteUrl());
  }

  async function memberByEmail(email: string) {
    return models.Member.findOne({ email }, { require: false });
  }

  async function giftByToken(token: string) {
    return models.Gift.findOne({ token }, { require: true });
  }

  /** Creates a welcome email automation for free or paid members. `removeAutomations` deletes it. */
  async function welcomeAutomation(status: 'free' | 'paid') {
    const design = await models.EmailDesignSetting.findOne(
      { slug: 'default-automated-email' },
      { require: true },
    );
    const automation = await models.Automation.add({
      name: `${status} welcome email`,
      slug: `member-welcome-email-${status}`,
      status: 'active',
    });
    await models.WelcomeEmailAutomatedEmail.add({
      welcome_email_automation_id: automation.id,
      delay_days: 0,
      subject: `Welcome, ${status} member!`,
      lexical: JSON.stringify({
        root: { children: [{ type: 'paragraph', children: [{ text: 'Welcome' }] }] },
      }),
      email_design_setting_id: design.id,
    });
    return automation;
  }

  async function removeAutomations(automations: Array<{ id: string }>) {
    for (const automation of automations) {
      const runs = await models.WelcomeEmailAutomationRun.findAll({
        filter: `welcome_email_automation_id:'${automation.id}'`,
      });
      for (const run of runs.models) {
        await models.WelcomeEmailAutomationRun.destroy({ id: run.id });
      }
      await models.Automation.destroy({ id: automation.id });
    }
  }

  beforeAll(async function () {
    ({ membersAgent } = await agentProvider.getAgentsForMembers());
    await fixtureManager.init('members');
    const paidTier = await models.Product.findOne({ type: 'paid' }, { require: true });
    paidTierId = paidTier.id;
  });

  beforeEach(function () {
    mockManager.mockStripe();
    const mail = mockManager.mockMail();
    sent = () => {
      const mails: SentMail[] = [];
      for (let next = mail.getSentEmail(0); next; next = mail.getSentEmail(mails.length)) {
        mails.push(next);
      }
      return mails;
    };
  });

  afterEach(async function () {
    await DomainEvents.allSettled();
    mockManager.restore();
  });

  describe('a visitor who is not a member', function () {
    it('creates a free member and redirects to the gift without redeeming it', async function () {
      const agent = membersAgent.duplicate();
      const email = `gift-new-${Date.now()}@example.com`;
      const token = await purchasedGift();

      await requestLink(agent, email, token);
      assert.equal(
        await memberByEmail(email),
        null,
        'expected no member before the link is opened',
      );
      const landed = await followLink(agent, email);
      await DomainEvents.allSettled();

      assert.equal(landed.hash, `#/portal/gift/redeem/${token}`);
      assert.equal(landed.searchParams.get('success'), 'true');
      const member = await memberByEmail(email);
      assert.equal(member.get('name'), 'Gift Receiver');
      assert.equal(member.get('status'), 'free');
      assert.equal((await giftByToken(token)).get('status'), 'purchased');
    });

    it('redirects to the gift instead of the free tier welcome page', async function () {
      const agent = membersAgent.duplicate();
      const email = `gift-welcome-page-${Date.now()}@example.com`;
      const token = await purchasedGift();
      const freeTier = await models.Product.findOne({ type: 'free' }, { require: true });
      const welcomePage = freeTier.get('welcome_page_url');
      await models.Product.edit({ welcome_page_url: '/welcome/' }, { id: freeTier.id });

      try {
        await requestLink(agent, email, token);
        const landed = await followLink(agent, email);

        assert.equal(landed.pathname, new URL(urlUtils.getSiteUrl()).pathname);
        assert.equal(landed.hash, `#/portal/gift/redeem/${token}`);
      } finally {
        await models.Product.edit({ welcome_page_url: welcomePage }, { id: freeTier.id });
      }
    });

    it('sends only the paid welcome email and the gift staff notification, once the member redeems', async function () {
      mockManager.mockLabsDisabled('automations');
      const agent = membersAgent.duplicate();
      const email = `gift-welcomed-${Date.now()}@example.com`;
      const token = await purchasedGift();
      const free = await welcomeAutomation('free');
      const paid = await welcomeAutomation('paid');

      try {
        await requestLink(agent, email, token);
        await followLink(agent, email);
        await DomainEvents.allSettled();
        const member = await memberByEmail(email);
        const welcomed = async () =>
          (
            await models.WelcomeEmailAutomationRun.findAll({ filter: `member_id:'${member.id}'` })
          ).models.map((run: { get(key: string): string }) =>
            run.get('welcome_email_automation_id'),
          );
        assert.deepEqual(
          await welcomed(),
          [],
          'expected no welcome email before the gift is redeemed',
        );

        await agent.post(`/api/gifts/${token}/redeem/`).body({}).expectStatus(200);
        await DomainEvents.allSettled();

        await member.refresh();
        assert.equal(member.get('status'), 'gift');
        const gift = await giftByToken(token);
        assert.equal(gift.get('status'), 'redeemed');
        assert.equal(gift.get('redeemer_member_id'), member.id);
        assert.deepEqual(await welcomed(), [paid.id]);
        await mockManager.assert.sentEmailEventually({ subject: /gift subscription redeemed/i });
        const toStaff = sent().filter(({ to }) => to !== email);
        assert.deepEqual(
          toStaff.map(({ subject }) => /gift subscription redeemed/i.test(subject)),
          [true],
          'expected only the gift notification to staff',
        );
      } finally {
        await removeAutomations([free, paid]);
      }
    });
  });

  describe('an existing member', function () {
    it('signs the member in and redirects to the gift without redeeming it', async function () {
      const agent = membersAgent.duplicate();
      const email = `gift-existing-${Date.now()}@example.com`;
      await models.Member.add({ email, name: 'Existing Member', email_disabled: false });
      await DomainEvents.allSettled();
      const token = await purchasedGift();

      await requestLink(agent, email, token);
      const landed = await followLink(agent, email);

      assert.equal(landed.hash, `#/portal/gift/redeem/${token}`);
      const member = await memberByEmail(email);
      assert.equal(member.get('name'), 'Existing Member');
      assert.equal(member.get('status'), 'free');
      assert.equal((await giftByToken(token)).get('status'), 'purchased');

      await agent.post(`/api/gifts/${token}/redeem/`).body({}).expectStatus(200);

      await member.refresh();
      assert.equal(member.get('status'), 'gift');
    });
  });

  it('returns an error and sends no email when the gift cannot be redeemed', async function () {
    const agent = membersAgent.duplicate();
    const email = `gift-redeemed-${Date.now()}@example.com`;
    const token = await purchasedGift({ status: 'redeemed', redeemed_at: new Date() });

    const { body } = await requestLink(agent, email, token, 400);

    assert.equal(body.errors[0].code, 'GIFT_REDEEMED');
    assert.equal(sent().length, 0);
    assert.equal(await memberByEmail(email), null);
  });
});
