const https = require('https');

// ============================================================================
// SMS service — Termii (https://termii.com)
// ============================================================================
// Termii is a Nigeria-based SMS/messaging API provider with good local
// delivery rates for Nigerian numbers — used for SMS 2FA codes.
//
// Required env vars:
//   TERMII_API_KEY    - from your Termii dashboard
//   TERMII_SENDER_ID  - a registered/approved Sender ID (e.g. "BowaGO")
//
// If these aren't set, sendSms() throws so callers can surface a clear
// "SMS not configured" error instead of silently failing.
// ============================================================================

const TERMII_API_KEY = process.env.TERMII_API_KEY;
const TERMII_SENDER_ID = process.env.TERMII_SENDER_ID || 'BowaGO';
const TERMII_HOST = 'api.ng.termii.com';

function isConfigured() {
  return !!TERMII_API_KEY;
}

/**
 * Normalize a Nigerian phone number to international format (234XXXXXXXXXX)
 * Termii expects numbers without a leading "+".
 */
function normalizePhone(phone) {
  let p = String(phone).trim().replace(/[^\d+]/g, '');
  if (p.startsWith('+')) p = p.slice(1);
  if (p.startsWith('0')) p = '234' + p.slice(1);
  if (!p.startsWith('234')) p = '234' + p;
  return p;
}

/**
 * Send an SMS via Termii.
 * @param {string} phone - destination phone number (any common format)
 * @param {string} message - the SMS body
 */
function sendSms(phone, message) {
  if (!isConfigured()) {
    throw new Error('SMS is not configured (missing TERMII_API_KEY)');
  }

  const to = normalizePhone(phone);
  const payload = JSON.stringify({
    to,
    from: TERMII_SENDER_ID,
    sms: message,
    type: 'plain',
    channel: 'generic',
    api_key: TERMII_API_KEY,
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: TERMII_HOST,
        path: '/api/sms/send',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            const json = JSON.parse(body);
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(json);
            } else {
              reject(new Error(json.message || `Termii error (${res.statusCode})`));
            }
          } catch (err) {
            reject(new Error(`Termii response parse error: ${body}`));
          }
        });
      },
    );

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/**
 * Send a 2FA / verification OTP via SMS.
 */
async function sendOtpSms(phone, code) {
  return sendSms(phone, `Your BowaGO verification code is ${code}. It expires in 10 minutes. Do not share this code.`);
}

module.exports = { sendSms, sendOtpSms, isConfigured: isConfigured, normalizePhone };
