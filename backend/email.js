require('dotenv').config();

const RESEND_API_URL = 'https://api.resend.com/emails';

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function getFromAddress() {
  return process.env.RESEND_FROM_EMAIL || 'ScrapeVerse Alerts <onboarding@resend.dev>';
}

async function sendPriceDropEmail({ to, title, url, oldPrice, newPrice, targetPrice, currency = 'INR' }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error('RESEND_API_KEY is not configured; price-drop email was not sent');
  }

  const symbol = currency === 'INR' ? '₹' : `${currency} `;
  const safeTitle = escapeHtml(title || 'Your watched product');
  const safeUrl = escapeHtml(url || '#');
  const oldLabel = `${symbol}${Number(oldPrice).toLocaleString('en-IN')}`;
  const newLabel = `${symbol}${Number(newPrice).toLocaleString('en-IN')}`;
  const targetLabel = targetPrice === null || targetPrice === undefined
    ? 'your target price'
    : `${symbol}${Number(targetPrice).toLocaleString('en-IN')}`;

  const response = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: getFromAddress(),
      to: [to],
      subject: `Price drop: ${title || 'Your watched product'}`,
      text: `${title || 'Your watched product'} dropped from ${oldLabel} to ${newLabel}. It is at or below ${targetLabel}. View it: ${url}`,
      html: `
        <div style="font-family:Arial,sans-serif;line-height:1.5;color:#1f2937;max-width:560px;">
          <h2 style="color:#1e3d2b;margin-bottom:8px;">🔔 Price drop detected</h2>
          <p><strong>${safeTitle}</strong> dropped from <strong>${oldLabel}</strong> to <strong style="color:#1e3d2b;">${newLabel}</strong>.</p>
          <p>This is at or below ${targetLabel}.</p>
          <p><a href="${safeUrl}" style="display:inline-block;background:#1e3d2b;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px;">View product</a></p>
          <p style="font-size:12px;color:#6b7280;">You received this because you enabled a ScrapeVerse price alert.</p>
        </div>
      `
    })
  });

  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(result?.message || result?.error || `Resend returned HTTP ${response.status}`);
  }

  return result;
}

module.exports = {
  sendPriceDropEmail
};
