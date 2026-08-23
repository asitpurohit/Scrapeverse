const db = require('./db');
const email = require('./email');

async function notifyPriceDrop({ productId, title, url, oldPrice, newPrice, currency = 'INR' }) {
  const previous = Number(oldPrice);
  const current = Number(newPrice);
  if (!productId || !Number.isFinite(previous) || !Number.isFinite(current) || current >= previous) {
    return { eligible: 0, sent: 0, failed: 0 };
  }

  const watchers = db.getUnnotifiedWatchers(productId, current);
  console.log(`[Price Alert] Evaluating price drop for "${title}": ₹${previous} → ₹${current}; ${watchers.length} eligible watcher(s)`);
  let sent = 0;
  let failed = 0;

  for (const watcher of watchers) {
    try {
      await email.sendPriceDropEmail({
        to: watcher.user_email,
        title,
        url,
        oldPrice: previous,
        newPrice: current,
        targetPrice: watcher.target_price,
        currency
      });
      db.markWatchersNotified([watcher.id]);
      sent += 1;
      console.log(`[Price Alert] Email accepted for ${watcher.user_email}: ${title} ₹${previous} → ₹${current}`);
    } catch (error) {
      failed += 1;
      console.warn(`[Price Alert] Email failed for ${watcher.user_email}:`, error.message);
    }
  }

  if (watchers.length > 0) {
    console.log(`[Price Alert] ${title}: ${sent} sent, ${failed} failed, ${watchers.length} eligible watcher(s)`);
  }

  return { eligible: watchers.length, sent, failed };
}

module.exports = {
  notifyPriceDrop
};
