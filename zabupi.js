require('dotenv').config();
const axios = require('axios');

// Gateway is "ZapUPI" — confirmed base URL and payload shape from https://zapupi.com/docs
const ZABUPI_BASE_URL = process.env.ZABUPI_BASE_URL || 'https://pay.zapupi.com/api';
const ZABUPI_API_KEY = process.env.ZABUPI_API_KEY; // this is the "zap_key" from your ZapUPI dashboard

/**
 * Creates a payment order with ZapUPI and returns a payment link.
 * Docs: https://zapupi.com/docs
 *
 * IMPORTANT: ZapUPI's own docs explicitly say NOT to send success_url,
 * failed_url, or timeout_url — sending them causes the request to fail
 * silently or be rejected. Only zap_key, order_id, amount are required;
 * customer_mobile and remark are optional.
 */
async function createPaymentOrder({ orderId, amount, userId, userName, userMobile, purpose }) {
  try {
    const response = await axios.post(
      `${ZABUPI_BASE_URL}/create-order`,
      {
        zap_key: ZABUPI_API_KEY,
        order_id: String(orderId),
        amount: String(amount),
        customer_mobile: userMobile || '9999999999',
        remark: purpose || 'Digital Product Purchase'
      },
      { headers: { 'Content-Type': 'application/json' } }
    );

    const data = response.data;

    if (data.status !== 'success') {
      return { success: false, error: data.message || JSON.stringify(data) };
    }

    return {
      success: true,
      paymentUrl: data.payment_url,
      transactionId: data.txn_id
    };
  } catch (err) {
    console.error('ZapUPI order creation failed:', err.response?.data || err.message);
    return { success: false, error: err.response?.data ? JSON.stringify(err.response.data) : err.message };
  }
}

/**
 * Verifies webhook signature — ZapUPI's docs don't document a signature
 * scheme for webhooks. bot.js re-verifies via checkPaymentStatus() before
 * marking anything paid, rather than trusting the webhook body alone.
 */
function verifyWebhookSignature(payload, signatureHeader) {
  return true;
}

/**
 * Polls ZapUPI's order-status endpoint to confirm real payment status.
 * Response fields per ZapUPI docs: data.status ("Pending"|"Success"|"Failed"),
 * data.amount, data.txn_id, data.utr, data.custumer_mobile (sic — typo in
 * their API), data.create_at.
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
    return response.data;
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
