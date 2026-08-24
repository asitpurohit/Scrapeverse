const crypto = require('crypto');
const postgres = require('./postgres-client');

const PRODUCT_FIELDS = `
  p.id, p.store_id, p.product_id, p.url, p.handle, p.title,
  p.description, p.category, p.brand, p.price, p.compare_at_price,
  p.currency, p.color, p.image_url, p.is_verified_scrape, p.source,
  p.ai_category, p.embedding_json, p.latest_data, p.created_at, p.updated_at,
  s.domain AS store_domain, s.platform AS store_platform
`;

function cleanDomain(value) {
  return String(value || '')
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .split('/')[0]
    .toLowerCase();
}

function jsonText(value) {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function parseJson(value, fallback) {
  try { return value ? JSON.parse(value) : fallback; } catch (error) { return fallback; }
}

async function getStoreByDomain(domain) {
  const result = await postgres.query('SELECT * FROM stores WHERE domain = $1 LIMIT 1', [cleanDomain(domain)]);
  return result.rows[0] || null;
}

async function getStoreByKey(domain, platform = 'shopify') {
  const result = await postgres.query(
    'SELECT * FROM stores WHERE domain = $1 AND platform = $2 LIMIT 1',
    [cleanDomain(domain), platform]
  );
  return result.rows[0] || null;
}

async function getStoreById(id) {
  const result = await postgres.query('SELECT * FROM stores WHERE id = $1', [id]);
  return result.rows[0] || null;
}

async function upsertStore(domain, platform = 'shopify') {
  const result = await postgres.query(`
    INSERT INTO stores (domain, platform, last_scraped_at)
    VALUES ($1, $2, CURRENT_TIMESTAMP)
    ON CONFLICT (domain, platform)
    DO UPDATE SET last_scraped_at = CURRENT_TIMESTAMP
    RETURNING id
  `, [cleanDomain(domain), platform]);
  return result.rows[0].id;
}

async function claimStoreCollectorProvisioning(storeId, retryDelayMs = 0) {
  const store = await getStoreById(storeId);
  if (!store) return { claimed: false, status: 'missing', store: null };
  if (store.collector_id && store.collector_status === 'ready') {
    return { claimed: false, status: 'ready', store };
  }

  const result = await postgres.query(`
    UPDATE stores
    SET collector_status = 'provisioning',
        collector_error = NULL,
        collector_attempts = COALESCE(collector_attempts, 0) + 1,
        collector_last_attempt_at = CURRENT_TIMESTAMP,
        collector_next_retry_at = CASE
          WHEN $2::bigint > 0 THEN CURRENT_TIMESTAMP + ($2::bigint * INTERVAL '1 millisecond')
          ELSE NULL
        END
    WHERE id = $1
      AND collector_status <> 'ready'
      AND (
        collector_status <> 'provisioning'
        OR collector_last_attempt_at IS NULL
        OR collector_last_attempt_at <= CURRENT_TIMESTAMP - INTERVAL '20 minutes'
      )
      AND (collector_next_retry_at IS NULL OR collector_next_retry_at <= CURRENT_TIMESTAMP)
    RETURNING *
  `, [storeId, Number(retryDelayMs) || 0]);

  return {
    claimed: result.rowCount > 0,
    status: 'provisioning',
    store: result.rows[0] || await getStoreById(storeId)
  };
}

async function markStoreCollectorReady(storeId, collectorId) {
  const result = await postgres.query(`
    UPDATE stores
    SET collector_id = $1, collector_status = 'ready', collector_error = NULL,
        collector_next_retry_at = NULL, collector_created_at = CURRENT_TIMESTAMP,
        last_scraped_at = CURRENT_TIMESTAMP
    WHERE id = $2
    RETURNING *
  `, [collectorId, storeId]);
  return result.rows[0] || null;
}

async function markStoreCollectorFailure(storeId, errorMessage, retryDelayMs = 60000) {
  const result = await postgres.query(`
    UPDATE stores
    SET collector_status = 'failed', collector_error = $1,
        collector_next_retry_at = CURRENT_TIMESTAMP + ($2::bigint * INTERVAL '1 millisecond')
    WHERE id = $3
    RETURNING *
  `, [String(errorMessage || 'Collector creation failed'), Number(retryDelayMs) || 60000, storeId]);
  return result.rows[0] || null;
}

async function getProductByUrl(url) {
  const cleanUrl = String(url || '').split('?')[0].replace(/\/$/, '');
  const result = await postgres.query(`
    SELECT ${PRODUCT_FIELDS}
    FROM products p
    LEFT JOIN stores s ON p.store_id = s.id
    WHERE p.url ILIKE $1 OR p.url = $2
    LIMIT 1
  `, [`%${cleanUrl}%`, cleanUrl]);
  return result.rows[0] || null;
}

async function getProductById(id) {
  const result = await postgres.query(`
    SELECT ${PRODUCT_FIELDS}
    FROM products p
    LEFT JOIN stores s ON p.store_id = s.id
    WHERE p.id = $1
  `, [id]);
  return result.rows[0] || null;
}

async function saveProduct(data) {
  const formattedAiCategory = Array.isArray(data.ai_category)
    ? JSON.stringify(data.ai_category)
    : (typeof data.ai_category === 'string' ? data.ai_category : null);

  return postgres.withTransaction(async (client) => {
    const existing = await client.query(
      'SELECT id, price FROM products WHERE url = $1 OR product_id = $2 LIMIT 1',
      [data.url, String(data.product_id)]
    );

    if (existing.rows[0]) {
      const id = existing.rows[0].id;
      await client.query(`
        UPDATE products
        SET title = $1, price = $2, compare_at_price = $3,
            category = COALESCE($4, category),
            ai_category = COALESCE($5, ai_category),
            image_url = $6, is_verified_scrape = $7,
            source = $8, latest_data = $9, updated_at = CURRENT_TIMESTAMP
        WHERE id = $10
      `, [
        data.title, data.price, data.compare_at_price ?? null,
        data.category ?? null, formattedAiCategory, data.image_url || '',
        Boolean(data.is_verified_scrape), data.source || 'Bright Data Scraper Studio',
        jsonText(data.latest_data), id
      ]);

      const latest = await client.query(
        'SELECT price FROM price_history WHERE product_id = $1 ORDER BY checked_at DESC LIMIT 1',
        [id]
      );
      if (!latest.rows[0] || Number(latest.rows[0].price) !== Number(data.price)) {
        await client.query(
          'INSERT INTO price_history (product_id, price, currency) VALUES ($1, $2, $3)',
          [id, data.price, data.currency || 'INR']
        );
      }
      return id;
    }

    const inserted = await client.query(`
      INSERT INTO products (
        store_id, product_id, url, handle, title, description, category,
        ai_category, brand, price, compare_at_price, currency, color, image_url,
        is_verified_scrape, source, latest_data
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      RETURNING id
    `, [
      data.store_id, String(data.product_id), data.url, data.handle || '',
      data.title, data.description || '', data.category || null,
      formattedAiCategory, data.brand || 'Brand', data.price,
      data.compare_at_price ?? null, data.currency || 'INR', data.color || '',
      data.image_url || '', Boolean(data.is_verified_scrape),
      data.source || 'Bright Data Scraper Studio', jsonText(data.latest_data)
    ]);
    const id = inserted.rows[0].id;
    await client.query(
      'INSERT INTO price_history (product_id, price, currency) VALUES ($1, $2, $3)',
      [id, data.price, data.currency || 'INR']
    );
    return id;
  });
}

async function getPriceHistory(productId) {
  const result = await postgres.query(`
    SELECT price, currency, checked_at FROM price_history
    WHERE product_id = $1 ORDER BY checked_at ASC
  `, [productId]);
  return result.rows;
}

async function getProductReviews(productId, limit = 100) {
  const result = await postgres.query(`
    SELECT review_text, author, rating, checked_at
    FROM reviews WHERE product_id = $1
    ORDER BY checked_at DESC LIMIT $2
  `, [productId, Number(limit) || 100]);
  return result.rows;
}

async function saveReview(productId, reviewText, author = 'Customer', rating = 5) {
  const fingerprint = crypto
    .createHash('sha256')
    .update(`${productId}|${String(author || '').trim().toLowerCase()}|${String(reviewText || '').trim().toLowerCase()}`)
    .digest('hex');
  const result = await postgres.query(`
    INSERT INTO reviews (product_id, review_text, author, rating, review_fingerprint)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (review_fingerprint) DO NOTHING
    RETURNING id
  `, [productId, reviewText, author, rating, fingerprint]);
  return result.rows[0]?.id || null;
}

async function saveReviewSummary(productId, data) {
  const actualData = typeof productId === 'object' ? productId : data;
  const prodId = typeof productId === 'object' ? productId.product_id : productId;
  const positive = actualData.positive_highlights?.length
    ? actualData.positive_highlights
    : (actualData.highlights || []);
  const packed = JSON.stringify({
    highlights: positive,
    positive_highlights: positive,
    negative_watchouts: actualData.negative_watchouts || [],
    delivery_insights: actualData.delivery_insights || null
  });
  await postgres.query(`
    INSERT INTO review_summaries (
      product_id, summary_text, sentiment, highlights_json, review_count_used,
      grounded_in, avg_rating, source_review_count, sample_count,
      latest_review_fingerprint, sampled_at, review_checked_at, review_source, review_status
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
      COALESCE($11::timestamptz, CURRENT_TIMESTAMP),
      COALESCE($12::timestamptz, CURRENT_TIMESTAMP),$13,$14)
    ON CONFLICT (product_id) DO UPDATE SET
      summary_text = EXCLUDED.summary_text,
      sentiment = EXCLUDED.sentiment,
      highlights_json = EXCLUDED.highlights_json,
      review_count_used = EXCLUDED.review_count_used,
      grounded_in = EXCLUDED.grounded_in,
      avg_rating = EXCLUDED.avg_rating,
      source_review_count = EXCLUDED.source_review_count,
      sample_count = EXCLUDED.sample_count,
      latest_review_fingerprint = EXCLUDED.latest_review_fingerprint,
      sampled_at = EXCLUDED.sampled_at,
      review_checked_at = EXCLUDED.review_checked_at,
      review_source = EXCLUDED.review_source,
      review_status = EXCLUDED.review_status,
      generated_at = CURRENT_TIMESTAMP
  `, [
    prodId,
    actualData.summary || 'Reviews unavailable for this store.',
    actualData.sentiment || 'Positive',
    packed,
    Number(actualData.review_count_used || actualData.review_count) || 0,
    actualData.grounded_in || 'Scraped customer reviews',
    actualData.avg_rating ?? null,
    Number(actualData.source_review_count || actualData.review_count || 0),
    Number(actualData.sample_count) || 0,
    actualData.latest_review_fingerprint || null,
    actualData.sampled_at || null,
    actualData.review_checked_at || null,
    actualData.review_source || 'judgeme',
    actualData.review_status || 'available'
  ]);
  return getCachedReviewSummary(prodId);
}

async function touchReviewChecked(productId) {
  return postgres.query(
    'UPDATE review_summaries SET review_checked_at = CURRENT_TIMESTAMP WHERE product_id = $1',
    [productId]
  );
}

async function deleteProductReviews(productId) {
  return postgres.query('DELETE FROM reviews WHERE product_id = $1', [productId]);
}

async function recordUserVisit(data) {
  const visitorId = String(data.visitor_id || '').trim();
  if (!visitorId) throw new Error('Missing visitor ID');
  const domain = cleanDomain(data.domain);
  const existing = await postgres.query(
    'SELECT id FROM user_history WHERE visitor_id = $1 AND visited_url = $2 ORDER BY visited_at DESC LIMIT 1',
    [visitorId, data.url]
  );
  if (existing.rows[0]) {
    await postgres.query('UPDATE user_history SET visited_at = CURRENT_TIMESTAMP WHERE id = $1', [existing.rows[0].id]);
    return existing.rows[0].id;
  }
  const result = await postgres.query(`
    INSERT INTO user_history (
      visitor_id, store_domain, store_platform, is_product_page, product_id,
      visited_url, visited_title, visited_price, visited_image
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    RETURNING id
  `, [
    visitorId, domain, data.platform || 'shopify', Boolean(data.isProductPage),
    data.product_id || null, data.url,
    data.title || (data.isProductPage ? 'Product Details' : `${domain.toUpperCase()} Store`),
    data.price ?? null, data.image_url || null
  ]);
  return result.rows[0].id;
}

async function recordTrafficEvent(data) {
  const visitorId = String(data.visitor_id || '').trim();
  const domain = cleanDomain(data.domain);
  const allowed = new Set(['store', 'product', 'order', 'other']);
  const pageType = allowed.has(data.page_type) ? data.page_type : 'other';
  if (!visitorId || !domain) throw new Error('Missing anonymous visitor ID or store domain');
  const duplicate = await postgres.query(`
    SELECT id FROM traffic_events
    WHERE visitor_id = $1 AND store_domain = $2 AND store_platform = $3
      AND page_type = $4 AND visited_at >= CURRENT_TIMESTAMP - INTERVAL '10 seconds'
    ORDER BY id DESC LIMIT 1
  `, [visitorId, domain, data.platform || 'shopify', pageType]);
  if (duplicate.rows[0]) return { id: duplicate.rows[0].id, recorded: false, duplicate: true };
  const result = await postgres.query(`
    INSERT INTO traffic_events (visitor_id, store_domain, store_platform, page_type)
    VALUES ($1,$2,$3,$4) RETURNING id
  `, [visitorId, domain, data.platform || 'shopify', pageType]);
  return { id: result.rows[0].id, recorded: true, duplicate: false };
}

async function getStoreTraffic(domain) {
  const clean = cleanDomain(domain);
  const configured = Number(process.env.TRAFFIC_UPLIFT_PERCENT);
  const upliftPercent = Number.isFinite(configured) ? Math.max(0, Math.min(200, Math.round(configured))) : 50;
  const [daily, fifteenDay, active] = await Promise.all([
    postgres.query(`SELECT COUNT(*)::int AS visits, COUNT(DISTINCT visitor_id)::int AS visitors
      FROM traffic_events WHERE store_domain = $1 AND visited_at >= CURRENT_TIMESTAMP - INTERVAL '24 hours'`, [clean]),
    postgres.query(`SELECT COUNT(*)::int AS visits, COUNT(DISTINCT visitor_id)::int AS visitors
      FROM traffic_events WHERE store_domain = $1 AND visited_at >= CURRENT_TIMESTAMP - INTERVAL '15 days'`, [clean]),
    postgres.query(`SELECT COUNT(DISTINCT visitor_id)::int AS visitors
      FROM traffic_events WHERE store_domain = $1 AND visited_at >= CURRENT_TIMESTAMP - INTERVAL '15 minutes'`, [clean])
  ]);
  const d = daily.rows[0] || {}, f = fifteenDay.rows[0] || {}, a = active.rows[0] || {};
  const observedVisitors = Number(d.visitors) || 0;
  const observedVisits = Number(d.visits) || 0;
  const observedVisitors15d = Number(f.visitors) || 0;
  const visits15d = Number(f.visits) || 0;
  return {
    dailyVisitors: observedVisitors + Math.round(observedVisitors * upliftPercent / 100),
    estimatedDailyVisitors: observedVisitors + Math.round(observedVisitors * upliftPercent / 100),
    observedVisitors,
    estimatedAdditionalVisitors: Math.round(observedVisitors * upliftPercent / 100),
    observedVisits,
    visitors15d: observedVisitors15d + Math.round(observedVisitors15d * upliftPercent / 100),
    estimatedVisitors15d: observedVisitors15d + Math.round(observedVisitors15d * upliftPercent / 100),
    observedVisitors15d,
    visits15d,
    activeNow: Number(a.visitors) || 0,
    upliftPercent,
    observedAt: new Date().toISOString()
  };
}

async function getUserBrowsingHistory(visitorId) {
  const cleanVisitorId = String(visitorId || '').trim();
  if (!cleanVisitorId) return [];
  const stores = await postgres.query(`
    SELECT store_domain, store_platform, MAX(visited_at) AS last_visited_at,
           COUNT(*)::int AS total_views, SUM(CASE WHEN is_product_page THEN 1 ELSE 0 END)::int AS product_views_count
    FROM user_history WHERE visitor_id = $1
    GROUP BY store_domain, store_platform ORDER BY last_visited_at DESC
  `, [cleanVisitorId]);
  const output = [];
  for (const store of stores.rows) {
    const products = await postgres.query(`
      SELECT uh.id AS history_id, uh.visited_url, uh.visited_title, uh.visited_price,
             uh.visited_image, uh.visited_at, p.title AS current_title,
             p.price AS current_price, p.compare_at_price, p.image_url AS current_image
      FROM user_history uh LEFT JOIN products p ON uh.product_id = p.id OR uh.visited_url = p.url
      WHERE uh.visitor_id = $1 AND uh.store_domain = $2 AND uh.is_product_page = TRUE
      ORDER BY uh.visited_at DESC
    `, [cleanVisitorId, store.store_domain]);
    const seen = new Set();
    const unique = products.rows.filter((item) => {
      if (seen.has(item.visited_url)) return false;
      seen.add(item.visited_url);
      const initial = Number(item.visited_price || item.current_price) || 0;
      const latest = Number(item.current_price || item.visited_price) || initial;
      const drop = initial - latest;
      item.url = item.visited_url;
      item.title = item.current_title || item.visited_title || 'Product Details';
      item.image_url = item.current_image || item.visited_image || '';
      item.visited_price = initial;
      item.current_price = latest;
      item.drop_amount = drop > 0 ? drop : 0;
      item.drop_percent = initial > 0 && drop > 0 ? Math.round(drop / initial * 100) : 0;
      return true;
    });
    output.push({
      domain: store.store_domain,
      brand: store.store_domain.split('.')[0].toUpperCase(),
      platform: store.store_platform,
      last_visited_at: store.last_visited_at,
      total_views: store.total_views,
      product_views_count: unique.length,
      products: unique
    });
  }
  return output;
}

async function clearAllData() {
  const tables = [
    'price_history', 'reviews', 'review_summaries', 'watchlist',
    'user_purchases', 'user_history', 'brand_reputations', 'health_logs',
    'collector_scrape_runs', 'traffic_events', 'user_tokens',
    'push_subscriptions', 'products', 'stores'
  ];
  await postgres.withTransaction(async (client) => {
    // CASCADE handles every declared foreign-key relationship regardless of
    // insertion order, while the transaction keeps the reset atomic.
    await client.query(`TRUNCATE TABLE ${tables.join(', ')} RESTART IDENTITY CASCADE`);
  });
  return Object.fromEntries(tables.map((table) => [table, 0]));
}

async function recordUserPurchase(data) {
  const domain = cleanDomain(data.domain);
  let productId = data.product_id || null;
  let title = data.title || 'Purchased Item';
  let image = data.image_url || '';
  let price = Number(data.price) || Number(data.total_amount) || 0;

  if (!productId && data.url) {
    const match = await postgres.query(`
      SELECT id, title, image_url, price FROM products
      WHERE url = $1 OR url ILIKE $2 ORDER BY id DESC LIMIT 1
    `, [data.url, `%${String(data.url).split('?')[0]}%`]);
    if (match.rows[0]) {
      productId = match.rows[0].id;
      title = data.title || match.rows[0].title;
      image = data.image_url || match.rows[0].image_url || '';
      price = Number(data.price) || Number(data.total_amount) || Number(match.rows[0].price) || 0;
    }
  }
  const result = await postgres.query(`
    INSERT INTO user_purchases (
      user_id, order_number, store_domain, store_platform, product_id, product_title,
      product_url, product_image, price_paid, quantity, total_order_amount,
      currency, order_status_url, user_email
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    RETURNING id, order_number
  `, [
    data.user_id || null, data.order_number || `ORD-${Date.now().toString().slice(-6)}`,
    domain, data.platform || 'shopify', productId, title, data.url || '', image,
    price, Number(data.quantity) || 1, Number(data.total_amount) || price,
    data.currency || 'INR', data.order_status_url || '', data.user_email || null
  ]);
  if (productId) await postgres.query('UPDATE watchlist SET notified = TRUE WHERE product_id = $1', [productId]);
  return { purchaseId: result.rows[0].id, orderNumber: result.rows[0].order_number, productId };
}

async function getUserPurchases(userEmail = null, userId = null) {
  if (!userEmail && !userId) return [];
  const values = [];
  let where;
  if (userId) {
    values.push(String(userId).trim());
    where = `up.user_id = $${values.length}`;
    if (userEmail) {
      values.push(String(userEmail).trim());
      where += ` AND LOWER(up.user_email) = LOWER($${values.length})`;
    }
  } else {
    values.push(String(userEmail).trim());
    where = `LOWER(up.user_email) = LOWER($${values.length}) AND up.user_id IS NULL`;
  }
  const result = await postgres.query(`
    SELECT up.*, p.price AS current_live_price, p.compare_at_price, p.image_url AS current_image
    FROM user_purchases up LEFT JOIN products p ON up.product_id = p.id
    WHERE ${where} ORDER BY up.purchased_at DESC
  `, values);
  return result.rows.map((purchase) => {
    const initial = Number(purchase.price_paid) || 0;
    const current = Number(purchase.current_live_price) || initial;
    const drop = Math.max(0, initial - current);
    return {
      ...purchase,
      brand: purchase.store_domain.split('.')[0].toUpperCase(),
      current_live_price: current,
      drop_since_purchase: drop,
      eligible_for_refund: drop > 0,
      refund_amount: drop
    };
  });
}

async function getProductPurchaseMetrics(productId) {
  const orders = await postgres.query('SELECT COUNT(*)::int AS count FROM user_purchases WHERE product_id = $1', [productId]);
  const summary = await postgres.query('SELECT review_count_used FROM review_summaries WHERE product_id = $1', [productId]);
  const reviews = await postgres.query('SELECT COUNT(*)::int AS count FROM reviews WHERE product_id = $1', [productId]);
  let reviewCount = Number(summary.rows[0]?.review_count_used) || Number(reviews.rows[0]?.count) || 0;
  if (!reviewCount) {
    const product = await postgres.query('SELECT is_verified_scrape FROM products WHERE id = $1', [productId]);
    if (product.rows[0]?.is_verified_scrape) reviewCount = 140;
  }
  const realOrders = Number(orders.rows[0]?.count) || 0;
  const lifetime = reviewCount > 0 ? reviewCount * 25 + realOrders : realOrders;
  const base30 = Math.round(lifetime * 0.12) + realOrders;
  const base90 = Math.round(lifetime * 0.32) + realOrders;
  const base6m = Math.round(lifetime * 0.65) + realOrders;
  return {
    productId: Number(productId), review_count: reviewCount, real_orders: realOrders,
    lifetime_purchases: lifetime, purchases_30d: base30, purchases_90d: base90,
    purchases_6m: base6m, sold_last_24h: Math.max(1, Math.round(base30 / 22)),
    formatted_badge: lifetime >= 1000 ? `${(lifetime / 1000).toFixed(1)}k+` : lifetime > 0 ? `${lifetime}+` : 'New Launch'
  };
}

async function batchUpdateWatchlist(email, activeProductIds = []) {
  if (!email) return;
  const cleanEmail = String(email).toLowerCase().trim();
  if (!activeProductIds.length) {
    await postgres.query('DELETE FROM watchlist WHERE LOWER(user_email) = $1', [cleanEmail]);
    return;
  }
  const placeholders = activeProductIds.map((_, index) => `$${index + 2}`).join(',');
  await postgres.query(
    `DELETE FROM watchlist WHERE LOWER(user_email) = $1 AND product_id NOT IN (${placeholders})`,
    [cleanEmail, ...activeProductIds]
  );
}

async function getStoreOverview(domain) {
  const clean = cleanDomain(domain);
  let store = await getStoreByDomain(clean);
  if (!store) {
    const id = await upsertStore(clean);
    store = await getStoreById(id);
  }
  let products = await getProductsByDomain(clean);
  if (!products.length) products = await getAllProducts();
  const history = await Promise.all(products.map((product) => getPriceHistory(product.id)));
  let currentTotal = 0;
  let sevenDayTotal = 0;
  let discounted = 0;
  products.forEach((product, index) => {
    const current = Number(product.price) || 0;
    const old = history[index].find((item) => new Date(item.checked_at).getTime() <= Date.now() - 7 * 86400000);
    const sevenDay = Number(old?.price || product.compare_at_price || current * 1.15);
    currentTotal += current;
    sevenDayTotal += sevenDay;
    if (Number(product.compare_at_price) > current || sevenDay > current) discounted += 1;
  });
  const netSavings = Math.max(0, sevenDayTotal - currentTotal);
  return {
    store: {
      id: store?.id || 1, domain: clean,
      brand: clean.split('.')[0].toUpperCase(), platform: store?.platform || 'shopify'
    },
    traffic: await getStoreTraffic(clean),
    volatility: {
      totalProducts: products.length,
      discountedCount: discounted,
      sumCurrentPrice: currentTotal,
      sum7dPrice: sevenDayTotal,
      netSavings,
      overallDropPct: sevenDayTotal > 0 ? Math.max(0, Math.round(netSavings / sevenDayTotal * 100)) : 0
    },
    trendingProducts: products.slice(0, 8)
  };
}

async function getCatalogProducts() {
  const products = await getAllProducts();
  return Promise.all(products.map(async (product) => {
    const history = await getPriceHistory(product.id);
    return { ...product, price_history: history.length ? history : [{ price: product.price }] };
  }));
}

async function getSimilarCandidates(category, excludeProductId, options = {}) {
  const { minPrice, maxPrice, color, brand, store_id, exclude_store_id, limit = 30 } = options;
  const values = [excludeProductId];
  let where = 'WHERE p.id <> $1';
  const add = (condition, value) => { values.push(value); where += ` AND ${condition.replace('?', `$${values.length}`)}`; };
  if (store_id) add('p.store_id = ?', store_id);
  else if (exclude_store_id) add('(p.store_id <> ? OR p.store_id IS NULL)', exclude_store_id);
  if (category) add('LOWER(p.category) = LOWER(?)', category);
  if (minPrice !== undefined && minPrice !== null) add('p.price >= ?', Number(minPrice));
  if (maxPrice !== undefined && maxPrice !== null) add('p.price <= ?', Number(maxPrice));
  if (color) add('LOWER(p.color) LIKE LOWER(?)', `%${color}%`);
  if (brand) add('LOWER(p.brand) LIKE LOWER(?)', `%${brand}%`);
  values.push(Number(limit) || 30);
  const result = await postgres.query(`
    SELECT ${PRODUCT_FIELDS} FROM products p LEFT JOIN stores s ON p.store_id = s.id
    ${where} ORDER BY p.id DESC LIMIT $${values.length}
  `, values);
  if (result.rows.length >= 2 || !category) return result.rows;
  const fallbackValues = [excludeProductId];
  let fallbackWhere = 'WHERE p.id <> $1';
  const fallbackAdd = (condition, value) => { fallbackValues.push(value); fallbackWhere += ` AND ${condition.replace('?', `$${fallbackValues.length}`)}`; };
  if (store_id) fallbackAdd('p.store_id = ?', store_id);
  else if (exclude_store_id) fallbackAdd('(p.store_id <> ? OR p.store_id IS NULL)', exclude_store_id);
  if (minPrice !== undefined && minPrice !== null) fallbackAdd('p.price >= ?', Number(minPrice));
  if (maxPrice !== undefined && maxPrice !== null) fallbackAdd('p.price <= ?', Number(maxPrice));
  fallbackValues.push(Number(limit) || 30);
  const fallback = await postgres.query(`
    SELECT ${PRODUCT_FIELDS} FROM products p LEFT JOIN stores s ON p.store_id = s.id
    ${fallbackWhere} ORDER BY p.id DESC LIMIT $${fallbackValues.length}
  `, fallbackValues);
  return fallback.rows;
}

async function getWatchedProductsNeeding24hCheck() {
  const result = await postgres.query(`
    SELECT DISTINCT ${PRODUCT_FIELDS}
    FROM products p JOIN watchlist w ON w.product_id = p.id
    LEFT JOIN stores s ON p.store_id = s.id
    WHERE (w.notified = FALSE OR w.notified IS NULL)
      AND (p.updated_at IS NULL OR p.updated_at <= CURRENT_TIMESTAMP - INTERVAL '24 hours')
  `);
  return result.rows;
}

async function savePushSubscription(data) {
  if (!data?.endpoint) return null;
  const result = await postgres.query(`
    INSERT INTO push_subscriptions (user_email, product_id, endpoint, p256dh, auth)
    VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (endpoint) DO UPDATE SET user_email = EXCLUDED.user_email, product_id = EXCLUDED.product_id
    RETURNING id
  `, [data.user_email || null, data.product_id || null, data.endpoint, data.p256dh || '', data.auth || '']);
  return result.rows[0].id;
}

async function getPushSubscriptionsForProduct(productId) {
  const result = await postgres.query(
    'SELECT * FROM push_subscriptions WHERE product_id = $1 OR product_id IS NULL',
    [productId]
  );
  return result.rows;
}

async function getOrCreateUserToken(email) {
  const cleanEmail = String(email || '').toLowerCase().trim();
  if (!cleanEmail) return null;
  const existing = await postgres.query('SELECT token FROM user_tokens WHERE email = $1', [cleanEmail]);
  if (existing.rows[0]) return existing.rows[0].token;
  const hash = crypto.createHmac('sha256', 'scrapeverse_secret_key_2026').update(cleanEmail).digest('hex').slice(0, 24);
  const token = `sv_tok_${hash}`;
  await postgres.query(
    'INSERT INTO user_tokens (token, email) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING',
    [token, cleanEmail]
  );
  const result = await postgres.query('SELECT token FROM user_tokens WHERE email = $1', [cleanEmail]);
  return result.rows[0]?.token || token;
}

async function getEmailByToken(token) {
  const cleanToken = String(token || '').trim();
  if (!cleanToken) return null;
  const result = await postgres.query('SELECT email FROM user_tokens WHERE token = $1', [cleanToken]);
  return result.rows[0]?.email || (cleanToken.includes('@') ? cleanToken : null);
}

async function addToWatchlist(productId, email, targetPrice = null, userId = null) {
  const cleanEmail = String(email || '').toLowerCase().trim();
  const cleanUserId = String(userId || '').trim() || null;
  if (!cleanEmail) throw new Error('Missing email');
  await getOrCreateUserToken(cleanEmail);
  const existing = await postgres.query(`
    SELECT id FROM watchlist
    WHERE product_id = $1 AND LOWER(user_email) = $2
      AND ((user_id = $3) OR (user_id IS NULL AND $3::text IS NULL))
    LIMIT 1
  `, [productId, cleanEmail, cleanUserId]);
  if (existing.rows[0]) {
    if (targetPrice !== null && targetPrice !== undefined) {
      await postgres.query('UPDATE watchlist SET target_price = $1, notified = FALSE WHERE id = $2', [targetPrice, existing.rows[0].id]);
    }
    return existing.rows[0].id;
  }
  const result = await postgres.query(`
    INSERT INTO watchlist (product_id, user_id, user_email, target_price)
    VALUES ($1, $2, $3, $4) RETURNING id
  `, [productId, cleanUserId, cleanEmail, targetPrice]);
  return result.rows[0].id;
}

async function removeFromWatchlist(productId, email, userId = null) {
  const result = await postgres.query(`
    DELETE FROM watchlist
    WHERE product_id = $1 AND user_email = $2
      AND ((user_id = $3) OR (user_id IS NULL AND $3::text IS NULL))
  `, [productId, email, String(userId || '').trim() || null]);
  return result;
}

async function getUserWatchlist(email = null, userId = null) {
  if (!email && !userId) return [];
  let condition = '';
  const values = [];
  if (userId) {
    values.push(String(userId).trim());
    condition = `w.user_id = $${values.length}`;
    if (email) {
      values.push(String(email).trim());
      condition += ` AND LOWER(w.user_email) = LOWER($${values.length})`;
    }
  } else {
    values.push(String(email).trim());
    condition = `LOWER(w.user_email) = LOWER($${values.length}) AND w.user_id IS NULL`;
  }
  const result = await postgres.query(`
    SELECT w.id AS watch_id, w.product_id, w.user_id, w.user_email, w.target_price,
           w.watched_since, p.title, p.price AS current_price, p.compare_at_price,
           p.image_url, p.url, s.domain AS store_domain, s.platform AS store_platform
    FROM watchlist w JOIN products p ON w.product_id = p.id
    LEFT JOIN stores s ON p.store_id = s.id
    WHERE ${condition} ORDER BY w.watched_since DESC
  `, values);
  return result.rows;
}

async function getUnnotifiedWatchers(productId, currentPrice) {
  const result = await postgres.query(`
    SELECT * FROM watchlist
    WHERE product_id = $1 AND notified = FALSE
      AND (target_price IS NULL OR target_price >= $2)
  `, [productId, currentPrice]);
  return result.rows;
}

async function touchProductChecked(productId) {
  return postgres.query('UPDATE products SET updated_at = CURRENT_TIMESTAMP WHERE id = $1', [productId]);
}

async function getAllStores() {
  const result = await postgres.query('SELECT * FROM stores ORDER BY last_scraped_at DESC');
  return result.rows;
}

async function getTableRows(table, limit = 1000) {
  const allowed = new Set([
    'stores', 'products', 'price_history', 'reviews', 'review_summaries',
    'user_purchases', 'watchlist', 'user_history', 'brand_reputations',
    'health_logs', 'collector_scrape_runs', 'user_tokens', 'push_subscriptions'
  ]);
  if (!allowed.has(table)) throw new Error(`Unsupported admin table: ${table}`);
  const result = await postgres.query(`SELECT * FROM ${table} ORDER BY id DESC LIMIT $1`, [Number(limit) || 1000]);
  return result.rows;
}

async function getFailedCollectorStores() {
  const result = await postgres.query(`
    SELECT domain, platform, collector_id, collector_status, collector_error,
           collector_attempts, collector_last_attempt_at, collector_next_retry_at,
           collector_created_at, last_scraped_at
    FROM stores WHERE collector_status = 'failed'
    ORDER BY collector_last_attempt_at DESC, domain ASC
  `);
  return result.rows;
}

async function getLatestHealthLogs(limit = 10) {
  const result = await postgres.query(
    'SELECT * FROM health_logs ORDER BY checked_at DESC LIMIT $1',
    [Number(limit) || 10]
  );
  return result.rows;
}

async function logHealthEvent(collectorId, domain, status, message, fields = 9) {
  return postgres.query(`
    INSERT INTO health_logs (collector_id, store_domain, status, message, fields_extracted)
    VALUES ($1,$2,$3,$4,$5) RETURNING id
  `, [collectorId, domain, status, message, Number(fields) || 0]);
}

async function recordCollectorScrapeRun(data) {
  const missing = Array.isArray(data.missing_core_fields) ? data.missing_core_fields : [];
  const result = await postgres.query(`
    INSERT INTO collector_scrape_runs (
      collector_id, store_id, store_domain, platform, product_url,
      status, missing_core_fields, fields_extracted
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id
  `, [
    data.collector_id, data.store_id || null, data.store_domain,
    data.platform || 'shopify', data.product_url || null,
    data.status || 'healthy', JSON.stringify(missing), Number(data.fields_extracted) || 0
  ]);
  return result.rows[0].id;
}

async function getRecentCollectorScrapeRuns(collectorId, limit = 5) {
  const result = await postgres.query(`
    SELECT * FROM collector_scrape_runs
    WHERE collector_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2
  `, [collectorId, Number(limit) || 5]);
  return result.rows;
}

async function claimCollectorHeal(storeId) {
  const result = await postgres.query(`
    UPDATE stores
    SET heal_status = 'running', heal_last_started_at = CURRENT_TIMESTAMP,
        heal_attempts = COALESCE(heal_attempts, 0) + 1, heal_error = NULL
    WHERE id = $1 AND collector_id IS NOT NULL AND collector_status = 'ready'
      AND (COALESCE(heal_status, 'idle') <> 'running'
        OR heal_last_started_at IS NULL
        OR heal_last_started_at <= CURRENT_TIMESTAMP - INTERVAL '15 minutes')
      AND (heal_next_allowed_at IS NULL OR heal_next_allowed_at <= CURRENT_TIMESTAMP)
    RETURNING *
  `, [storeId]);
  return { claimed: result.rowCount > 0, store: result.rows[0] || await getStoreById(storeId) };
}

async function finishCollectorHeal(storeId, status, errorMessage = null, cooldownMs = 30 * 60 * 1000) {
  const safeStatus = status === 'repaired' ? 'idle' : 'failed';
  const seconds = Math.max(0, Math.ceil(Number(cooldownMs) / 1000));
  const result = await postgres.query(`
    UPDATE stores
    SET heal_status = $1, heal_last_completed_at = CURRENT_TIMESTAMP,
        heal_next_allowed_at = CURRENT_TIMESTAMP + ($2::bigint * INTERVAL '1 second'),
        heal_error = $3
    WHERE id = $4 RETURNING *
  `, [safeStatus, seconds, errorMessage ? String(errorMessage) : null, storeId]);
  return result.rows[0] || null;
}

async function getAllProducts() {
  const result = await postgres.query(`
    SELECT ${PRODUCT_FIELDS} FROM products p
    LEFT JOIN stores s ON p.store_id = s.id
    ORDER BY p.updated_at DESC LIMIT 100
  `);
  return result.rows;
}

async function getProductsByDomain(domain) {
  const clean = cleanDomain(domain);
  const result = await postgres.query(`
    SELECT ${PRODUCT_FIELDS} FROM products p
    LEFT JOIN stores s ON p.store_id = s.id
    WHERE LOWER(s.domain) = $1 OR LOWER(p.url) LIKE $2
    ORDER BY p.updated_at DESC
  `, [clean, `%${clean}%`]);
  return result.rows;
}

async function searchProducts(queryText = '', domain = '', limit = 10) {
  const values = [];
  let where = 'WHERE 1=1';
  if (domain?.trim()) {
    const clean = cleanDomain(domain);
    values.push(clean, `%${clean.split('.')[0]}%`);
    where += ` AND (LOWER(s.domain) = $${values.length - 1} OR LOWER(p.brand) LIKE $${values.length})`;
  }
  if (queryText?.trim()) {
    const clean = queryText.trim().toLowerCase();
    values.push(`%${clean}%`, `%${clean}%`, `%${clean}%`);
    where += ` AND (LOWER(p.title) LIKE $${values.length - 2} OR LOWER(p.url) LIKE $${values.length - 1} OR LOWER(p.handle) LIKE $${values.length})`;
  }
  values.push(Number(limit) || 10);
  const result = await postgres.query(`
    SELECT p.id, p.title, p.price, p.compare_at_price, p.image_url, p.url, p.brand,
           s.domain AS store_domain
    FROM products p LEFT JOIN stores s ON p.store_id = s.id
    ${where} ORDER BY p.id DESC LIMIT $${values.length}
  `, values);
  return result.rows;
}

async function markWatchersNotified(ids = []) {
  if (!ids.length) return;
  const placeholders = ids.map((_, index) => `$${index + 1}`).join(',');
  return postgres.query(`UPDATE watchlist SET notified = TRUE WHERE id IN (${placeholders})`, ids);
}

async function getBrandReputation(domain) {
  const result = await postgres.query(`
    SELECT * FROM brand_reputations
    WHERE LOWER(domain) = LOWER($1)
      AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
    LIMIT 1
  `, [cleanDomain(domain)]);
  const row = result.rows[0];
  if (!row) return null;
  return { ...row, sources: parseJson(row.sources_json, []), fromCache: true, cached_at: row.researched_at };
}

async function saveBrandReputation(data) {
  if (!data?.domain) return null;
  const domain = cleanDomain(data.domain);
  const result = await postgres.query(`
    INSERT INTO brand_reputations (
      domain, brand_name, trust_score, scam_risk, sentiment_label, ai_summary,
      sources_json, total_mentions, positive_mentions, negative_mentions,
      researched_at, expires_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP + INTERVAL '30 days')
    ON CONFLICT (domain) DO UPDATE SET
      brand_name = EXCLUDED.brand_name,
      trust_score = EXCLUDED.trust_score,
      scam_risk = EXCLUDED.scam_risk,
      sentiment_label = EXCLUDED.sentiment_label,
      ai_summary = EXCLUDED.ai_summary,
      sources_json = EXCLUDED.sources_json,
      total_mentions = EXCLUDED.total_mentions,
      positive_mentions = EXCLUDED.positive_mentions,
      negative_mentions = EXCLUDED.negative_mentions,
      researched_at = CURRENT_TIMESTAMP,
      expires_at = CURRENT_TIMESTAMP + INTERVAL '30 days'
    RETURNING *
  `, [
    domain,
    data.brand_name || domain.split('.')[0].toUpperCase(),
    Number(data.trust_score) || 92,
    data.scam_risk || 'LOW',
    data.sentiment_label || 'Verified Authentic Brand',
    data.ai_summary || '',
    jsonText(data.sources || []),
    Number(data.total_mentions) || 0,
    Number(data.positive_mentions) || 0,
    Number(data.negative_mentions) || 0
  ]);
  const row = result.rows[0];
  return { ...row, sources: parseJson(row.sources_json, []), fromCache: false };
}

async function getCachedReviewSummary(productId) {
  const result = await postgres.query(`
    SELECT *,
      EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - generated_at)) / 86400 AS age_days,
      EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - COALESCE(review_checked_at, generated_at))) / 86400 AS review_check_age_days
    FROM review_summaries WHERE product_id = $1
  `, [productId]);
  const row = result.rows[0];
  if (!row) return null;
  const parsed = parseJson(row.highlights_json, {});
  const positive = Array.isArray(parsed) ? parsed : (parsed.positive_highlights || parsed.highlights || []);
  return {
    summary: row.review_status === 'unavailable' ? 'Reviews unavailable for this store.' : row.summary_text,
    sentiment: row.review_status === 'unavailable' ? 'Reviews Unavailable' : row.sentiment,
    highlights: positive,
    positive_highlights: positive,
    negative_watchouts: parsed.negative_watchouts || [],
    delivery_insights: parsed.delivery_insights || null,
    review_count: row.review_count_used,
    source_review_count: row.source_review_count || row.review_count_used || 0,
    sample_count: row.sample_count || 0,
    latest_review_fingerprint: row.latest_review_fingerprint || null,
    sampled_at: row.sampled_at || row.generated_at,
    review_checked_at: row.review_checked_at || row.generated_at,
    review_check_age_days: Number(row.review_check_age_days) || 0,
    avg_rating: row.avg_rating || null,
    grounded_in: row.grounded_in,
    review_source: row.review_source || 'judgeme',
    review_status: row.review_status || 'available',
    generated_at: row.generated_at,
    fromCache: true
  };
}

module.exports = {
  cleanDomain,
  getStoreByDomain,
  getStoreByKey,
  getStoreById,
  upsertStore,
  claimStoreCollectorProvisioning,
  markStoreCollectorReady,
  markStoreCollectorFailure,
  getProductByUrl,
  getProductById,
  saveProduct,
  getPriceHistory,
  getProductReviews,
  saveReview,
  saveReviewSummary,
  touchReviewChecked,
  deleteProductReviews,
  recordUserVisit,
  trackStoreVisit: recordUserVisit,
  recordTrafficEvent,
  getStoreTraffic,
  getUserBrowsingHistory,
  clearAllData,
  recordUserPurchase,
  getUserPurchases,
  getProductPurchaseMetrics,
  batchUpdateWatchlist,
  getStoreOverview,
  getCatalogProducts,
  getSimilarCandidates,
  getWatchedProductsNeeding24hCheck,
  savePushSubscription,
  getPushSubscriptionsForProduct,
  getOrCreateUserToken,
  getEmailByToken,
  addToWatchlist,
  removeFromWatchlist,
  getUserWatchlist,
  getUnnotifiedWatchers,
  markWatchersNotified,
  touchProductChecked,
  getAllStores,
  getTableRows,
  getFailedCollectorStores,
  getLatestHealthLogs,
  logHealthEvent,
  recordCollectorScrapeRun,
  getRecentCollectorScrapeRuns,
  claimCollectorHeal,
  finishCollectorHeal,
  getAllProducts,
  getProductsByDomain,
  searchProducts,
  getBrandReputation,
  saveBrandReputation,
  getCachedReviewSummary,
  getPool: postgres.getPool,
  close: postgres.close,
  crypto
};
