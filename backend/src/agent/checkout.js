'use strict';
// Stripe TEST-mode checkout for the agent demo. Refuses any key that is not sk_test_ - this path can never
// charge a real card. The receipt is read back from Stripe (not trusted from the browser) and lands in the packet.
function createTestCheckout({ key, fetchImpl = fetch }) {
  const enabled = typeof key === 'string' && key.startsWith('sk_test_');
  const api = async (method, p, form) => {
    const r = await fetchImpl('https://api.stripe.com/v1' + p, {
      method, headers: { authorization: 'Bearer ' + key, ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      body: form ? new URLSearchParams(form) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('stripe: ' + ((j.error && j.error.message) || r.status));
    return j;
  };
  return {
    enabled,
    async create({ base, tokenId, packetId }) {
      if (!enabled) throw Object.assign(new Error('Stripe TEST mode is not configured on this server (STRIPE_TEST_SECRET_KEY).'), { status: 503 });
      const s = await api('POST', '/checkout/sessions', {
        mode: 'subscription',
        'line_items[0][quantity]': '1',
        'line_items[0][price_data][currency]': 'usd',
        'line_items[0][price_data][unit_amount]': '5999',
        'line_items[0][price_data][recurring][interval]': 'month',
        'line_items[0][price_data][product_data][name]': 'SecondShift (DEMO - Stripe test mode, no real charge)',
        'subscription_data[trial_period_days]': '30',
        'subscription_data[description]': 'Agent demo purchase - TEST MODE',
        success_url: `${base}/agent/checkout/done?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${base}/agent/checkout/done?cancelled=1`,
        'metadata[agent_token_id]': tokenId, 'metadata[packet_id]': packetId || '', 'metadata[demo]': 'true',
      });
      return { url: s.url, session_ref: s.id.slice(-10), expires_at: s.expires_at ? new Date(s.expires_at * 1000).toISOString() : null };
    },
    async receipt(sessionId) {
      if (!enabled) throw Object.assign(new Error('not configured'), { status: 503 });
      if (!/^cs_test_[A-Za-z0-9]+$/.test(String(sessionId))) throw Object.assign(new Error('not a test-mode checkout session'), { status: 400 });
      const s = await api('GET', '/checkout/sessions/' + encodeURIComponent(sessionId));
      return {
        mode: 'test', label: 'DEMO - Stripe TEST mode, no real charge',
        session_ref: s.id.slice(-10), status: s.status, payment_status: s.payment_status,
        amount_due_today: (s.amount_total || 0) / 100, currency: (s.currency || 'usd').toUpperCase(),
        plan: 'SecondShift $59.99/month after 30-day free trial', subscription_ref: s.subscription ? String(s.subscription).slice(-10) : null,
        created_at: s.created ? new Date(s.created * 1000).toISOString() : null,
        agent_token_id: s.metadata && s.metadata.agent_token_id || null, packet_id: s.metadata && s.metadata.packet_id || null,
      };
    },
  };
}

module.exports = { createTestCheckout };
