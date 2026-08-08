require('dotenv').config();
const axios = require('axios');

// NOTE: The gateway is actually called "ZapUPI" (not "Zabupi") — base URL confirmed
// from https://zapupi.com/docs
const ZABUPI_BASE_URL = process.env.ZABUPI_BASE_URL || 'https://pay.zapupi.com/api';
const ZABUPI_API_KEY = process.env.ZABUPI_API_KEY; // this is the "zap_key" ZapUPI gives you

/**
 * Creates a payment order with ZapUPI and returns a payment link.
 * Matches the documented ZapUPI /create-order endpoint exactly.
 * Docs: https://zapupi.com/docs
 *
 * Required by ZapUPI: zap_key, order_id, amount, customer_mobile, remark,
 * success_url, failed_url, timeout_url, webhook_url
 */
async function createPaymentOrder({ orderId, amount, userId, userName, userMobile, purpose }) {
  try {
    const response = await axios.post(
      `${ZABUPI_BASE_URL}/create-order`,
      {
        zap_key: ZABUPI_API_KEY,
        order_id: String(orderId),
        amount: String(amount),
        // ZapUPI requires a mobile number. Telegram doesn't give us one by default,
        // so we fall back to a dummy number if not collected. Real UPI collection
        // still works via the payment_url — this field is mainly for their records.
        customer_mobile: userMobile || '9999999999',
        remark: purpose || 'Digital Product Purchase',
        success_url: `${process.env.WEBHOOK_BASE_URL}/payment-success?orderId=${orderId}`,
        failed_url: `${process.env.WEBHOOK_BASE_URL}/payment-failed?orderId=${orderId}`,
        timeout_url: `${process.env.WEBHOOK_BASE_URL}/payment-timeout?orderId=${orderId}`,
        webhook_url: `${process.env.WEBHOOK_BASE_URL}/webhook/zabupi`
      },
      { headers: { 'Content-Type': 'application/json' } }
    );

    const data = response.data;

    if (data.status !== 'success') {
      return { success: false, error: data.message || 'Order creation failed' };
    }

    return {
      success: true,
      paymentUrl: data.payment_url,
      transactionId: data.txn_id
    };
  } catch (err) {
    console.error('ZapUPI order creation failed:', err.response?.data || err.message);
    return { success: false, error: err.response?.data || err.message };
  }
}

/**
 * Verifies webhook signature — NOTE: ZapUPI's docs (as found) don't show a
 * documented HMAC signing scheme for webhooks. Confirm with ZapUPI support
 * whether they sign requests. Until confirmed, this treats the webhook as
 * trusted based on knowing your own webhook_url is secret + validated by
 * re-checking the order status via checkPaymentStatus() below before
 * marking anything paid (see bot.js webhook handler).
 */
function verifyWebhookSignature(payload, signatureHeader) {
  // No documented signature scheme found for ZapUPI webhooks.
  // Safer approach used in bot.js: always re-verify via checkPaymentStatus()
  // rather than trusting the webhook body alone.
  return true;
}

/**
 * Polls ZapUPI's order-status endpoint to confirm real payment status.
 * Use this to double check before delivering a product — don't trust the
 * webhook payload alone since we couldn't confirm its signing scheme.
 */
async function checkPaymentStatus(orderId) {
  try {
    const response = await axios.post(
      `${ZABUPI_BASE_URL}/order-status`,
      {
        zap_key: ZABUPI_API_KEY,
        order_id: String(orderId)
      },
      { headers: { 'Content-Type': 'application/json' } }
    );
    return response.data; // check actual field names against a real response before going live
  } catch (err) {
    console.error('ZapUPI status check failed:', err.response?.data || err.message);
    return null;
  }
}

module.exports = {
  createPaymentOrder,
  verifyWebhookSignature,
  checkPaymentStatus
};
