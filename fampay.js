require('dotenv').config();
const axios = require('axios');

// Base URL and API key can be overridden by the admin panel at runtime
// (stored in localdb's paymentSettings) — these .env values are just the
// initial defaults. Callers should pass { baseUrl, apiKey } when they have
// fresher values from fb.getPaymentSettings().
const DEFAULT_BASE_URL = process.env.FAMPAY_BASE_URL || 'https://payment-getaway-bot-production.up.railway.app';
const DEFAULT_API_KEY = process.env.FAMPAY_API_KEY;

function client(overrides = {}) {
  return axios.create({
    baseURL: overrides.baseUrl || DEFAULT_BASE_URL,
    headers: { Authorization: `Bearer ${overrides.apiKey || DEFAULT_API_KEY}` }
  });
}

/**
 * Step 0 (optional) — Generates a payment QR code for a given UPI ID + amount.
 * Docs: GET /api/qr?upi=...&amount=...
 * Orders auto-cancel after 10 minutes if no UTR is submitted.
 */
async function generateQr(upiId, amount, settings = {}) {
  try {
    const response = await client(settings).get('/api/qr', {
      params: { upi: upiId, amount }
    });

    if (response.data.status !== 'success') {
      return { success: false, error: response.data.message || 'QR generation failed' };
    }

    const data = response.data.data;
    return {
      success: true,
      orderId: data.order_id,
      upiLink: data.upi_link,
      qrImageUrl: data.qr_image_url,
      amount: data.amount,
      expiresInSeconds: data.expires_in_seconds
    };
  } catch (err) {
    console.error('FamPay QR generation failed:', err.response?.data || err.message);
    return { success: false, error: err.response?.data?.message || err.message };
  }
}

/**
 * Step 1 — Submits a UTR for verification. Verification is ASYNC (usually
 * resolves within 30 seconds) — this call just registers the UTR and
 * returns a txn_id to poll with checkVerificationStatus().
 */
async function submitUtr({ amount, utr, referenceId, orderId }, settings = {}) {
  try {
    const body = { amount, utr, reference_id: referenceId };
    if (orderId) body.order_id = orderId;

    const response = await client(settings).post('/api/verify', body);

    return {
      success: true,
      txnId: response.data.txn_id,
      status: response.data.status,
      verified: response.data.verified
    };
  } catch (err) {
    console.error('FamPay UTR submission failed:', err.response?.data || err.message);
    return { success: false, error: err.response?.data?.message || err.message };
  }
}

/**
 * Step 2 — Polls the verification status for a submitted UTR.
 * status: "pending" | "success" | "failed" | "cancelled"
 */
async function checkVerificationStatus(txnId, settings = {}) {
  try {
    const response = await client(settings).get(`/api/verify/status/${txnId}`);
    return response.data; // { status, verified, amount, utr }
  } catch (err) {
    console.error('FamPay status check failed:', err.response?.data || err.message);
    return null;
  }
}

/**
 * Step 3 — Payment history from FamPay's own records (separate from our
 * local order history — mainly useful for admin reconciliation/debugging).
 */
async function getPaymentHistory({ status, limit } = {}, settings = {}) {
  try {
    const params = {};
    if (status) params.status = status;
    if (limit) params.limit = limit;

    const response = await client(settings).get('/api/history', { params });
    return response.data;
  } catch (err) {
    console.error('FamPay history fetch failed:', err.response?.data || err.message);
    return null;
  }
}

module.exports = {
  generateQr,
  submitUtr,
  checkVerificationStatus,
  getPaymentHistory
};
