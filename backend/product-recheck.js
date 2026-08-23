const db = require('./db');
const brightdata = require('./brightdata');
const { notifyPriceDrop } = require('./price-alerts');

function getProductJsonCandidates(url) {
  const cleanUrl = String(url || '').split('?')[0].replace(/\/$/, '');
  if (!cleanUrl) return [];

  let domain = '';
  try {
    domain = new URL(cleanUrl).hostname;
  } catch {
    return [];
  }

  const handle = cleanUrl.includes('/products/')
    ? cleanUrl.split('/products/')[1]?.split('/')[0]
    : null;
  const candidates = [];

  if (handle) candidates.push(`https://${domain}/products/${handle}.json`);
  if (!cleanUrl.endsWith('.json')) candidates.push(`${cleanUrl}.json`);
  else candidates.push(cleanUrl);

  return [...new Set(candidates)];
}

/**
 * Shared live product check used by visitor revisits, the alert cron, and the
 * top-bar Recheck button. It intentionally checks only product JSON fields:
 * title, price, and compare-at price.
 */
async function recheckProduct(product, { source = 'Product Recheck' } = {}) {
  if (!product?.id || !product.url) {
    return { success: false, checked: false, error: 'Product URL is unavailable', product };
  }

  let liveData = null;
  let lastError = null;

  for (const endpoint of getProductJsonCandidates(product.url)) {
    try {
      const candidate = await brightdata.scrapeWithBrightDataUnlocker(endpoint);
      if (candidate?.product?.variants?.[0]) {
        liveData = candidate;
        break;
      }
    } catch (error) {
      lastError = error;
    }
  }

  if (!liveData?.product?.variants?.[0]) {
    return {
      success: false,
      checked: false,
      error: lastError?.message || 'Live product JSON was unavailable',
      product
    };
  }

  const liveProduct = liveData.product;
  const variant = liveProduct.variants[0];
  const livePrice = parseFloat(variant.price);
  if (!Number.isFinite(livePrice) || livePrice <= 0) {
    return { success: false, checked: false, error: 'Live product price was invalid', product };
  }

  const currentPrice = Number(product.price) || 0;
  const currentCompare = Number.isFinite(Number(product.compare_at_price))
    ? Number(product.compare_at_price)
    : null;
  const hasCompareField = Object.prototype.hasOwnProperty.call(variant, 'compare_at_price');
  const parsedCompare = hasCompareField ? parseFloat(variant.compare_at_price) : NaN;
  const liveCompare = hasCompareField && Number.isFinite(parsedCompare) ? parsedCompare : null;
  const liveTitle = brightdata.cleanDecodedText(liveProduct.title);

  const titleChanged = Boolean(liveTitle && liveTitle !== product.title);
  const priceChanged = livePrice !== currentPrice;
  const compareChanged = hasCompareField && liveCompare !== currentCompare;
  const oldPrice = currentPrice;
  const priceDrop = priceChanged && oldPrice > 0 && livePrice < oldPrice
    ? {
        productId: product.id,
        title: liveTitle || product.title,
        url: product.url,
        oldPrice,
        newPrice: livePrice,
        currency: product.currency || 'INR'
      }
    : null;

  const updatedProduct = { ...product };
  if (titleChanged) updatedProduct.title = liveTitle;
  if (priceChanged) updatedProduct.price = livePrice;
  if (compareChanged) updatedProduct.compare_at_price = liveCompare;

  if (titleChanged || priceChanged || compareChanged) {
    db.saveProduct(updatedProduct);
  }

  // A valid live response advances the 24-hour product-check timestamp even
  // when all three values are unchanged.
  if (db.touchProductChecked) db.touchProductChecked(product.id);

  const savedProduct = titleChanged || priceChanged || compareChanged
    ? (db.getProductById(product.id) || updatedProduct)
    : product;

  if (titleChanged) {
    console.log(`[${source}] 📝 Name changed: "${product.title}" → "${liveTitle}"`);
  }
  if (priceChanged) {
    console.log(`[${source}] 💰 Price changed: ₹${oldPrice} → ₹${livePrice}`);
  }
  if (compareChanged) {
    console.log(`[${source}] 🏷️ Compare-at price changed: ₹${currentCompare || 0} → ₹${liveCompare || 0}`);
  }
  if (!titleChanged && !priceChanged && !compareChanged) {
    console.log(`[${source}] ✓ Product unchanged: "${product.title}" (₹${livePrice})`);
  }

  if (titleChanged || priceChanged || compareChanged) {
    const domain = new URL(product.url).hostname.replace(/^www\./, '');
    const activeCollector = db.getStoreById(product.store_id)?.collector_id || 'store-collector-pending';
    if (db.logHealthEvent) {
      db.logHealthEvent(
        activeCollector,
        domain,
        'healthy',
        `${source}: Updated product #${product.id} (Price: ₹${livePrice})`,
        9
      );
    }
  }

  if (priceDrop) {
    // Do not make a visitor, cron cycle, or demo button wait for email delivery.
    notifyPriceDrop(priceDrop).catch(error => {
      console.warn(`[${source}] Price-drop notification failed:`, error.message);
    });
  }

  return {
    success: true,
    checked: true,
    changed: titleChanged || priceChanged || compareChanged,
    titleChanged,
    priceChanged,
    compareChanged,
    priceDrop,
    product: savedProduct
  };
}

module.exports = { recheckProduct };
