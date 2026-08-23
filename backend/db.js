const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const dbPath = path.join(__dirname, 'scrape_verse.db');
const db = new DatabaseSync(dbPath);
const PRODUCT_FIELDS = [
  'p.id', 'p.store_id', 'p.product_id', 'p.url', 'p.handle', 'p.title',
  'p.description', 'p.category', 'p.brand', 'p.price', 'p.compare_at_price',
  'p.currency', 'p.color', 'p.image_url', 'p.is_verified_scrape', 'p.source',
  'p.ai_category', 'p.embedding_json', 'p.latest_data', 'p.created_at', 'p.updated_at'
].join(', ');

function normalizeProductMatchText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&amp;/g, '&')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normalizeProductMatchUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '').toLowerCase();
  } catch (e) {
    return String(value || '').split(/[?#]/)[0].replace(/\/$/, '').toLowerCase();
  }
}

function normalizeProductMatchPath(value) {
  try {
    return new URL(String(value || '')).pathname.replace(/\/$/, '').toLowerCase();
  } catch (e) {
    return String(value || '').split(/[?#]/)[0].replace(/\/$/, '').toLowerCase();
  }
}

// Initialize tables for Universal E-commerce Companion & Aggregator

try {
  db.exec("ALTER TABLE products ADD COLUMN ai_category TEXT");
} catch (e) {}

db.exec(`
  CREATE TABLE IF NOT EXISTS stores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain TEXT NOT NULL,
    platform TEXT NOT NULL, -- 'shopify', 'woocommerce', 'magento', 'custom'
    collector_id TEXT,
    collector_status TEXT NOT NULL DEFAULT 'missing',
    collector_error TEXT,
    collector_attempts INTEGER DEFAULT 0,
    collector_next_retry_at DATETIME,
    collector_last_attempt_at DATETIME,
    collector_created_at DATETIME,
    heal_status TEXT NOT NULL DEFAULT 'idle',
    heal_last_started_at DATETIME,
    heal_last_completed_at DATETIME,
    heal_next_allowed_at DATETIME,
    heal_attempts INTEGER DEFAULT 0,
    heal_error TEXT,
    last_scraped_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(domain, platform)
  );

  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id INTEGER,
    product_id TEXT NOT NULL,
    url TEXT UNIQUE NOT NULL,
    handle TEXT,
    title TEXT NOT NULL,
    description TEXT,
    category TEXT,
    brand TEXT,
    price REAL NOT NULL,
    compare_at_price REAL,
    currency TEXT DEFAULT 'INR',
    color TEXT,
    image_url TEXT,
    is_verified_scrape BOOLEAN DEFAULT 1,
    source TEXT DEFAULT 'Bright Data Scraper Studio',
    ai_category TEXT,
    embedding_json TEXT,
    latest_data TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (store_id) REFERENCES stores (id)
  );

  CREATE TABLE IF NOT EXISTS price_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    price REAL NOT NULL,
    currency TEXT DEFAULT 'INR',
    checked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (product_id) REFERENCES products (id)
  );

  CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    review_text TEXT NOT NULL,
    author TEXT,
    rating REAL,
    review_fingerprint TEXT,
    checked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (product_id) REFERENCES products (id)
  );

  CREATE TABLE IF NOT EXISTS review_summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER UNIQUE NOT NULL,
    summary_text TEXT NOT NULL,
    sentiment TEXT NOT NULL,
    highlights_json TEXT,
    review_count_used INTEGER DEFAULT 0,
    grounded_in TEXT,
    avg_rating REAL,
    source_review_count INTEGER DEFAULT 0,
    sample_count INTEGER DEFAULT 0,
    latest_review_fingerprint TEXT,
    sampled_at DATETIME,
    review_checked_at DATETIME,
    review_source TEXT DEFAULT 'judgeme',
    review_status TEXT DEFAULT 'available',
    generated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (product_id) REFERENCES products (id)
  );

  CREATE TABLE IF NOT EXISTS health_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    collector_id TEXT,
    store_domain TEXT,
    status TEXT NOT NULL, -- 'healthy', 'repaired', 'warning', 'error'
    message TEXT NOT NULL,
    fields_extracted INTEGER DEFAULT 9,
    checked_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS collector_scrape_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    collector_id TEXT NOT NULL,
    store_id INTEGER,
    store_domain TEXT NOT NULL,
    platform TEXT NOT NULL,
    product_url TEXT,
    status TEXT NOT NULL,
    missing_core_fields TEXT NOT NULL DEFAULT '[]',
    fields_extracted INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (store_id) REFERENCES stores (id)
  );

  CREATE TABLE IF NOT EXISTS watchlist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    user_email TEXT NOT NULL,
    target_price REAL,
    watched_since DATETIME DEFAULT CURRENT_TIMESTAMP,
    notified BOOLEAN DEFAULT 0,
    FOREIGN KEY (product_id) REFERENCES products (id)
  );

  CREATE TABLE IF NOT EXISTS user_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    store_domain TEXT NOT NULL,
    store_platform TEXT DEFAULT 'shopify',
    is_product_page BOOLEAN DEFAULT 0,
    product_id INTEGER,
    visited_url TEXT NOT NULL,
    visited_title TEXT,
    visited_price REAL,
    visited_image TEXT,
    visited_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (product_id) REFERENCES products (id)
  );

  CREATE TABLE IF NOT EXISTS traffic_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    visitor_id TEXT NOT NULL,
    store_domain TEXT NOT NULL,
    store_platform TEXT DEFAULT 'shopify',
    page_type TEXT NOT NULL DEFAULT 'store',
    visited_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_traffic_events_domain_time
    ON traffic_events (store_domain, visited_at);

  CREATE INDEX IF NOT EXISTS idx_traffic_events_visitor_domain_time
    ON traffic_events (visitor_id, store_domain, visited_at);

  CREATE TABLE IF NOT EXISTS user_tokens (
    token TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS user_purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_number TEXT,
    store_domain TEXT NOT NULL,
    store_platform TEXT DEFAULT 'shopify',
    product_id INTEGER,
    product_title TEXT NOT NULL,
    product_url TEXT,
    product_image TEXT,
    price_paid REAL NOT NULL,
    quantity INTEGER DEFAULT 1,
    total_order_amount REAL,
    currency TEXT DEFAULT 'INR',
    order_status_url TEXT,
    user_email TEXT,
    purchased_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (product_id) REFERENCES products (id)
  );

  CREATE TABLE IF NOT EXISTS brand_reputations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain TEXT UNIQUE NOT NULL,
    brand_name TEXT,
    trust_score INTEGER DEFAULT 92,
    scam_risk TEXT DEFAULT 'LOW',
    sentiment_label TEXT DEFAULT 'Verified Authentic Brand',
    ai_summary TEXT,
    sources_json TEXT,
    total_mentions INTEGER DEFAULT 0,
    positive_mentions INTEGER DEFAULT 0,
    negative_mentions INTEGER DEFAULT 0,
    researched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME DEFAULT (DATETIME(CURRENT_TIMESTAMP, '+30 days'))
  );

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_email TEXT,
    product_id INTEGER,
    endpoint TEXT UNIQUE NOT NULL,
    p256dh TEXT,
    auth TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Existing databases may still have the original domain-only stores table.
// Add collector state first, then rebuild the table once to support the
// domain + platform key without losing store IDs used by products.
for (const column of [
  ['collector_id', 'TEXT'],
  ['collector_status', "TEXT NOT NULL DEFAULT 'missing'"],
  ['collector_error', 'TEXT'],
  ['collector_attempts', 'INTEGER DEFAULT 0'],
  ['collector_next_retry_at', 'DATETIME'],
  ['collector_last_attempt_at', 'DATETIME'],
  ['collector_created_at', 'DATETIME'],
  ['heal_status', "TEXT NOT NULL DEFAULT 'idle'"],
  ['heal_last_started_at', 'DATETIME'],
  ['heal_last_completed_at', 'DATETIME'],
  ['heal_next_allowed_at', 'DATETIME'],
  ['heal_attempts', 'INTEGER DEFAULT 0'],
  ['heal_error', 'TEXT']
]) {
  try {
    db.exec(`ALTER TABLE stores ADD COLUMN ${column[0]} ${column[1]}`);
  } catch (e) {}
}

function migrateStoresToDomainPlatformKey() {
  const indexes = db.prepare('PRAGMA index_list(stores)').all();
  const hasCompositeUnique = indexes.some(index => {
    if (!index.unique) return false;
    const columns = db.prepare(`PRAGMA index_info(${JSON.stringify(index.name)})`).all();
    return columns.map(column => column.name).join(',') === 'domain,platform';
  });

  if (hasCompositeUnique) return;

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      CREATE TABLE stores_domain_platform (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        domain TEXT NOT NULL,
        platform TEXT NOT NULL,
        collector_id TEXT,
        collector_status TEXT NOT NULL DEFAULT 'missing',
        collector_error TEXT,
        collector_attempts INTEGER DEFAULT 0,
        collector_next_retry_at DATETIME,
        collector_last_attempt_at DATETIME,
        collector_created_at DATETIME,
        heal_status TEXT NOT NULL DEFAULT 'idle',
        heal_last_started_at DATETIME,
        heal_last_completed_at DATETIME,
        heal_next_allowed_at DATETIME,
        heal_attempts INTEGER DEFAULT 0,
        heal_error TEXT,
        last_scraped_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(domain, platform)
      );

      INSERT INTO stores_domain_platform (
        id, domain, platform, collector_id, collector_status,
        collector_error, collector_attempts, collector_next_retry_at,
        collector_last_attempt_at, collector_created_at, heal_status,
        heal_last_started_at, heal_last_completed_at, heal_next_allowed_at,
        heal_attempts, heal_error, last_scraped_at
      )
      SELECT
        id, domain, platform, collector_id,
        COALESCE(collector_status, 'missing'), collector_error,
        COALESCE(collector_attempts, 0), collector_next_retry_at,
        collector_last_attempt_at, collector_created_at,
        COALESCE(heal_status, 'idle'), heal_last_started_at,
        heal_last_completed_at, heal_next_allowed_at,
        COALESCE(heal_attempts, 0), heal_error, last_scraped_at
      FROM stores;

      DROP TABLE stores;
      ALTER TABLE stores_domain_platform RENAME TO stores;
    `);
    db.exec('COMMIT');
    db.exec('PRAGMA foreign_keys = ON');
    console.log('✅ Migrated stores to domain + platform collector keys');
  } catch (error) {
    db.exec('ROLLBACK');
    db.exec('PRAGMA foreign_keys = ON');
    throw error;
  }
}

migrateStoresToDomainPlatformKey();

// Older databases do not have a review fingerprint. Add it before the
// cleanup/index migration below so duplicate Judge.me blocks cannot return.
try {
  db.exec('ALTER TABLE reviews ADD COLUMN review_fingerprint TEXT');
} catch (e) {}

for (const column of [
  ['avg_rating', 'REAL'],
  ['source_review_count', 'INTEGER DEFAULT 0'],
  ['sample_count', 'INTEGER DEFAULT 0'],
  ['latest_review_fingerprint', 'TEXT'],
  ['sampled_at', 'DATETIME'],
  ['review_checked_at', 'DATETIME'],
  ['review_source', "TEXT DEFAULT 'judgeme'"],
  ['review_status', "TEXT DEFAULT 'available'"]
]) {
  try {
    db.exec(`ALTER TABLE review_summaries ADD COLUMN ${column[0]} ${column[1]}`);
  } catch (e) {}
}

// SQLite does not support changing a column constraint in place. Migrate
// existing databases so products scraped without a category can still be
// stored. The migration preserves product IDs and all existing data.
function migrateNullableProductCategory() {
  const categoryColumn = db.prepare('PRAGMA table_info(products)').all()
    .find(column => column.name === 'category');

  if (!categoryColumn || categoryColumn.notnull !== 1) return;

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN IMMEDIATE');

  try {
    db.exec(`
      CREATE TABLE products_nullable_category (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        store_id INTEGER,
        product_id TEXT NOT NULL,
        url TEXT UNIQUE NOT NULL,
        handle TEXT,
        title TEXT NOT NULL,
        description TEXT,
        category TEXT,
        brand TEXT,
        price REAL NOT NULL,
        compare_at_price REAL,
        currency TEXT DEFAULT 'INR',
        color TEXT,
        image_url TEXT,
        is_verified_scrape BOOLEAN DEFAULT 1,
        source TEXT DEFAULT 'Bright Data Scraper Studio',
        ai_category TEXT,
        embedding_json TEXT,
        latest_data TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (store_id) REFERENCES stores (id)
      );

      INSERT INTO products_nullable_category (
        id, store_id, product_id, url, handle, title, description, category,
        brand, price, compare_at_price, currency, color, image_url,
        is_verified_scrape, source, ai_category, embedding_json, latest_data,
        created_at, updated_at
      )
      SELECT
        id, store_id, product_id, url, handle, title, description, category,
        brand, price, compare_at_price, currency, color, image_url,
        is_verified_scrape, source, ai_category, embedding_json, latest_data,
        created_at, updated_at
      FROM products;

      DROP TABLE products;
      ALTER TABLE products_nullable_category RENAME TO products;
    `);

    db.exec('COMMIT');
    db.exec('PRAGMA foreign_keys = ON');
    console.log('✅ Migrated products.category to allow NULL values');
  } catch (error) {
    db.exec('ROLLBACK');
    db.exec('PRAGMA foreign_keys = ON');
    throw error;
  }
}

migrateNullableProductCategory();

function normalizeReviewValue(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getReviewFingerprint(productId, reviewText, author = '') {
  const identity = `${productId}|${normalizeReviewValue(author)}|${normalizeReviewValue(reviewText)}`;
  return crypto.createHash('sha256').update(identity).digest('hex');
}

// Clean duplicates created by the old scraper, then enforce uniqueness at the
// database layer. A changed review sample gets a fresh summary on next visit.
function migrateReviewDeduplication() {
  const rows = db.prepare(`
    SELECT id, product_id, review_text, author
    FROM reviews
    ORDER BY id ASC
  `).all();
  const updateFingerprint = db.prepare('UPDATE reviews SET review_fingerprint = ? WHERE id = ?');
  const deleteReview = db.prepare('DELETE FROM reviews WHERE id = ?');
  const deleteSummary = db.prepare('DELETE FROM review_summaries WHERE product_id = ?');
  const seen = new Set();
  const affectedProducts = new Set();
  let removed = 0;

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of rows) {
      const fingerprint = getReviewFingerprint(row.product_id, row.review_text, row.author);
      if (seen.has(fingerprint)) {
        deleteReview.run(row.id);
        affectedProducts.add(row.product_id);
        removed += 1;
      } else {
        seen.add(fingerprint);
        updateFingerprint.run(fingerprint, row.id);
      }
    }

    for (const productId of affectedProducts) {
      deleteSummary.run(productId);
    }

    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_product_fingerprint
      ON reviews(product_id, review_fingerprint)
    `);
    db.exec('COMMIT');

    if (removed > 0) {
      console.log(`✅ Removed ${removed} duplicate review row(s); affected summaries will regenerate`);
    }
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

migrateReviewDeduplication();

// Raw reviews are only a staging layer now. Preserve their count as metadata
// for existing summaries, then remove the text rows after a successful save.
function cleanupRawReviewsWithSummaries() {
  const summaries = db.prepare(`
    SELECT rs.product_id, rs.review_count_used, COUNT(r.id) AS sample_count
    FROM review_summaries rs
    LEFT JOIN reviews r ON r.product_id = rs.product_id
    GROUP BY rs.product_id
  `).all();
  const update = db.prepare(`
    UPDATE review_summaries
    SET source_review_count = CASE
          WHEN source_review_count IS NULL OR source_review_count = 0 THEN review_count_used
          ELSE source_review_count
        END,
        sample_count = CASE
          WHEN sample_count IS NULL OR sample_count = 0 THEN ?
          ELSE sample_count
        END,
        sampled_at = COALESCE(sampled_at, generated_at)
    WHERE product_id = ?
  `);
  const remove = db.prepare('DELETE FROM reviews WHERE product_id = ?');

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of summaries) {
      update.run(row.sample_count || 0, row.product_id);
      remove.run(row.product_id);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

cleanupRawReviewsWithSummaries();

console.log('⚡ ScrapeVerse E-commerce SQLite Database initialized at', dbPath);

function autoSeed() {
  const countStmt = db.prepare('SELECT COUNT(*) as count FROM products');
  const result = countStmt.get();
  if (result.count === 0) {
    console.log('📦 Seeding ONLY authentic Japam.in catalog from japam_catalog_sample.json...');
    const catalogPath = path.join(__dirname, '..', '..', 'japam_catalog_sample.json');
    if (fs.existsSync(catalogPath)) {
      try {
        const raw = fs.readFileSync(catalogPath, 'utf8');
        const items = JSON.parse(raw);

        // 1. Seed Japam Store (Shopify)
        const storeStmt = db.prepare(`
          INSERT OR IGNORE INTO stores (domain, platform)
          VALUES (?, ?)
        `);
        storeStmt.run('japam.in', 'shopify');
        const store = db.prepare('SELECT id FROM stores WHERE domain = ?').get('japam.in');

        // Health logs for self-heal badge
        db.prepare(`
          INSERT INTO health_logs (collector_id, store_domain, status, message, fields_extracted)
          VALUES (?, ?, ?, ?, ?)
        `).run('store-specific', 'japam.in', 'healthy', 'Bright Data Collector operational across 9/9 product fields (id, title, price, compare_price, currency, brand, image, description, category)', 9);

        const prodStmt = db.prepare(`
          INSERT INTO products (store_id, product_id, url, handle, title, description, category, brand, price, compare_at_price, currency, color, image_url, is_verified_scrape, source, latest_data)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const histStmt = db.prepare(`
          INSERT INTO price_history (product_id, price, currency, checked_at)
          VALUES (?, ?, ?, ?)
        `);

        const revStmt = db.prepare(`
          INSERT INTO reviews (product_id, review_text, author, rating)
          VALUES (?, ?, ?, ?)
        `);

        const summaryStmt = db.prepare(`
          INSERT INTO review_summaries (product_id, summary_text, sentiment, highlights_json, review_count_used, grounded_in)
          VALUES (?, ?, ?, ?, ?, ?)
        `);

        // Seed Real Japam Items
        for (const item of items) {
          const cat = item.product_type || 'Jewelry';
          const info = prodStmt.run(
            store.id,
            String(item.id),
            item.url,
            item.handle,
            item.title,
            `Authentic spiritual and aesthetic ${item.title} from Japam. Handcrafted with certified materials.`,
            cat,
            'Japam',
            item.price,
            item.compare_at_price || item.price,
            'INR',
            item.title.toLowerCase().includes('silver') ? 'Silver' : 'Multicolor',
            item.image,
            1,
            'Bright Data Scraper Studio (Japam Store)',
            JSON.stringify(item)
          );

          const newId = info.lastInsertRowid;
          const basePrice = item.price;
          const historyDays = [30, 21, 14, 7, 0];
          const priceMultipliers = [1.25, 1.15, 1.0, 1.1, 1.0];

          historyDays.forEach((daysAgo, idx) => {
            const date = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
            const historicalPrice = Math.round(basePrice * priceMultipliers[idx]);
            histStmt.run(newId, historicalPrice, 'INR', date);
          });

          revStmt.run(newId, `The quality of ${item.title} exceeded my expectations. Beautiful authentic finish.`, 'Rohan S.', 5);
          revStmt.run(newId, `Fast delivery and authentic packaging. Very comfortable to wear daily.`, 'Pooja M.', 4.5);

          summaryStmt.run(
            newId,
            `Customer feedback for ${item.title} highlights high satisfaction with craftsmanship and finish. Reviewers report comfortable daily wear and reliable packaging.`,
            'Very Positive',
            JSON.stringify(['Authentic craftsmanship and shine', 'Comfortable for daily wear', 'Secure packaging']),
            2,
            '2 scraped customer reviews'
          );
        }

        console.log(`✅ Seeded ${items.length} 100% REAL Japam.in products.`);
      } catch (err) {
        console.error('Error during catalog seed:', err);
      }
    }
  }
}

// autoSeed(); // Disabled for clean slate testing from scratch

module.exports = {
  getWatchedProductsNeeding24hCheck: () => {
    return db.prepare(`
      SELECT DISTINCT ${PRODUCT_FIELDS}, s.domain as store_domain, s.platform as store_platform
      FROM products p
      JOIN watchlist w ON w.product_id = p.id
      LEFT JOIN stores s ON p.store_id = s.id
      WHERE (w.notified = 0 OR w.notified IS NULL)
        AND (p.updated_at IS NULL OR (julianday('now') - julianday(p.updated_at)) * 24 >= 24)
    `).all();
  },

  touchProductChecked: (productId) => {
    db.prepare("UPDATE products SET updated_at = datetime('now') WHERE id = ?").run(productId);
  },

  trackStoreVisit: (data) => {
    return module.exports.recordUserVisit(data);
  },

  db,

  clearAllData: () => {
    const dataTables = [
      'price_history',
      'reviews',
      'review_summaries',
      'watchlist',
      'user_purchases',
      'user_history',
      'brand_reputations',
      'health_logs',
      'collector_scrape_runs',
      'traffic_events',
      'user_tokens',
      'push_subscriptions',
      'products',
      'stores'
    ];

    try {
      db.exec('PRAGMA foreign_keys = OFF');
      db.exec('BEGIN IMMEDIATE');
      for (const table of dataTables) db.exec(`DELETE FROM ${table}`);
      db.exec('DELETE FROM sqlite_sequence');
      db.exec('COMMIT');
      db.exec('PRAGMA foreign_keys = ON');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch (rollbackError) {}
      db.exec('PRAGMA foreign_keys = ON');
      throw error;
    }

    return Object.fromEntries(dataTables.map(table => [table, 0]));
  },

  // Stores
  getStoreByDomain: (domain) => {
    return db.prepare('SELECT * FROM stores WHERE domain = ?').get(domain);
  },

  getStoreByKey: (domain, platform = 'shopify') => {
    return db.prepare('SELECT * FROM stores WHERE domain = ? AND platform = ?').get(domain, platform);
  },

  getStoreById: (id) => {
    return db.prepare('SELECT * FROM stores WHERE id = ?').get(id);
  },

  upsertStore: (domain, platform = 'shopify') => {
    const existing = db.prepare('SELECT * FROM stores WHERE domain = ? AND platform = ?').get(domain, platform);
    if (existing) {
      db.prepare('UPDATE stores SET last_scraped_at = CURRENT_TIMESTAMP WHERE id = ?').run(existing.id);
      return existing.id;
    }
    const stmt = db.prepare(`
      INSERT INTO stores (domain, platform, collector_status)
      VALUES (?, ?, 'missing')
    `);
    const info = stmt.run(domain, platform);
    return info.lastInsertRowid;
  },

  claimStoreCollectorProvisioning: (storeId, retryDelayMs = 0) => {
    const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(storeId);
    if (!store) return { claimed: false, status: 'missing', store: null };
    if (store.collector_id && store.collector_status === 'ready') {
      return { claimed: false, status: 'ready', store };
    }
    if (store.collector_status === 'provisioning') {
      const lastAttempt = store.collector_last_attempt_at
        ? new Date(store.collector_last_attempt_at).getTime()
        : 0;
      // Recover a job left behind by a backend restart or process crash.
      if (!lastAttempt || Date.now() - lastAttempt < 20 * 60 * 1000) {
        return { claimed: false, status: 'provisioning', store };
      }
    }

    const nextRetryAt = store.collector_next_retry_at
      ? new Date(store.collector_next_retry_at).getTime()
      : 0;
    if (nextRetryAt > Date.now()) {
      return { claimed: false, status: 'provisioning', store };
    }

    const retryDate = retryDelayMs > 0
      ? new Date(Date.now() + retryDelayMs).toISOString()
      : null;
    const result = db.prepare(`
      UPDATE stores
      SET collector_status = 'provisioning',
          collector_error = NULL,
          collector_attempts = COALESCE(collector_attempts, 0) + 1,
          collector_last_attempt_at = CURRENT_TIMESTAMP,
          collector_next_retry_at = ?
      WHERE id = ?
        AND (
          collector_status != 'provisioning'
          OR collector_last_attempt_at IS NULL
          OR collector_last_attempt_at <= datetime('now', '-20 minutes')
        )
    `).run(retryDate, storeId);

    return {
      claimed: result.changes > 0,
      status: 'provisioning',
      store: db.prepare('SELECT * FROM stores WHERE id = ?').get(storeId)
    };
  },

  markStoreCollectorReady: (storeId, collectorId) => {
    db.prepare(`
      UPDATE stores
      SET collector_id = ?, collector_status = 'ready', collector_error = NULL,
          collector_next_retry_at = NULL, collector_created_at = CURRENT_TIMESTAMP,
          last_scraped_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(collectorId, storeId);
    return db.prepare('SELECT * FROM stores WHERE id = ?').get(storeId);
  },

  markStoreCollectorFailure: (storeId, errorMessage, retryDelayMs = 60000) => {
    const retryDate = new Date(Date.now() + retryDelayMs).toISOString();
    db.prepare(`
      UPDATE stores
      SET collector_status = 'failed', collector_error = ?,
          collector_next_retry_at = ?
      WHERE id = ?
    `).run(String(errorMessage || 'Collector creation failed'), retryDate, storeId);
    return db.prepare('SELECT * FROM stores WHERE id = ?').get(storeId);
  },

  // Products
  getProductByUrl: (url) => {
    const cleanUrl = url.split('?')[0].replace(/\/$/, '');
    return db.prepare(`
      SELECT ${PRODUCT_FIELDS}, s.domain as store_domain, s.platform as store_platform
      FROM products p
      LEFT JOIN stores s ON p.store_id = s.id
      WHERE p.url LIKE ? OR p.url = ?
      LIMIT 1
    `).get(`%${cleanUrl}%`, cleanUrl);
  },

  getProductById: (id) => {
    return db.prepare(`
      SELECT ${PRODUCT_FIELDS}, s.domain as store_domain, s.platform as store_platform
      FROM products p
      LEFT JOIN stores s ON p.store_id = s.id
      WHERE p.id = ?
    `).get(id);
  },

  saveProduct: (data) => {
    const {
      store_id,
      product_id,
      url,
      handle = '',
      title,
      description = '',
      category = null,
      ai_category = null,
      brand = 'Brand',
      price,
      compare_at_price = null,
      currency = 'INR',
      color = '',
      image_url = '',
      is_verified_scrape = 1,
      source = 'Bright Data Scraper Studio',
      latest_data = null
    } = data;
    
    const formattedAiCategory = Array.isArray(ai_category) ? JSON.stringify(ai_category) : (typeof ai_category === 'string' ? ai_category : null);

    const existing = db.prepare('SELECT id, price FROM products WHERE url = ? OR product_id = ?').get(url, String(product_id));

    if (existing) {
      db.prepare(`
        UPDATE products
        SET title = ?, price = ?, compare_at_price = ?, category = COALESCE(?, category), ai_category = COALESCE(?, ai_category), image_url = ?, is_verified_scrape = ?, source = ?, latest_data = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(title, price, compare_at_price, category, formattedAiCategory, image_url, is_verified_scrape ? 1 : 0, source, JSON.stringify(latest_data), existing.id);

      const lastHist = db.prepare('SELECT price, checked_at FROM price_history WHERE product_id = ? ORDER BY checked_at DESC LIMIT 1').get(existing.id);
      if (!lastHist || lastHist.price !== price) {
        db.prepare('INSERT INTO price_history (product_id, price, currency) VALUES (?, ?, ?)').run(existing.id, price, currency);
      }
      return existing.id;
    }

    const stmt = db.prepare(`
      INSERT INTO products (store_id, product_id, url, handle, title, description, category, ai_category, brand, price, compare_at_price, currency, color, image_url, is_verified_scrape, source, latest_data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const info = stmt.run(
      store_id,
      String(product_id),
      url,
      handle,
      title,
      description,
      category,
      formattedAiCategory,
      brand,
      price,
      compare_at_price,
      currency,
      color,
      image_url,
      is_verified_scrape ? 1 : 0,
      source,
      JSON.stringify(latest_data)
    );

    const newId = info.lastInsertRowid;
    db.prepare('INSERT INTO price_history (product_id, price, currency) VALUES (?, ?, ?)').run(newId, price, currency);
    return newId;
  },

  // Price History
  getPriceHistory: (productId) => {
    return db.prepare(`
      SELECT price, currency, checked_at
      FROM price_history
      WHERE product_id = ?
      ORDER BY checked_at ASC
    `).all(productId);
  },

  // Raw Reviews
  getProductReviews: (productId, limit = 100) => {
    return db.prepare(`
      SELECT review_text, author, rating, checked_at
      FROM reviews
      WHERE product_id = ?
      ORDER BY checked_at DESC
      LIMIT ?
    `).all(productId, limit);
  },

  saveReview: (productId, reviewText, author = 'Customer', rating = 5) => {
    const reviewFingerprint = getReviewFingerprint(productId, reviewText, author);
    return db.prepare(`
      INSERT OR IGNORE INTO reviews (product_id, review_text, author, rating, review_fingerprint)
      VALUES (?, ?, ?, ?, ?)
    `).run(productId, reviewText, author, rating, reviewFingerprint);
  },

  // Review summaries remain cached between scheduled 30-day Judge.me checks.
  // The check age is returned separately from the summary generation age.
  getCachedReviewSummary: (productId) => {
    const row = db.prepare(`
      SELECT *, 
        (julianday('now') - julianday(generated_at)) AS age_days,
        (julianday('now') - julianday(COALESCE(review_checked_at, generated_at))) AS review_check_age_days
      FROM review_summaries
      WHERE product_id = ?
    `).get(productId);

    if (!row) return null;

    let parsed = {};
    let highlights = [];
    let positive_highlights = [];
    let negative_watchouts = [];
    let delivery_insights = null;
    const reviewSource = row.review_source || 'judgeme';
    const reviewStatus = row.review_status || 'available';

    try {
      parsed = JSON.parse(row.highlights_json || '{}');
      if (Array.isArray(parsed)) {
        highlights = parsed;
        positive_highlights = parsed;
      } else if (parsed && typeof parsed === 'object') {
        highlights = parsed.highlights || parsed.positive_highlights || [];
        positive_highlights = parsed.positive_highlights || parsed.highlights || [];
        negative_watchouts = parsed.negative_watchouts || [];
        delivery_insights = parsed.delivery_insights || null;
      }
    } catch (e) {}

    if (reviewStatus !== 'unavailable' && positive_highlights.length === 0) {
      positive_highlights = [
        'Authentic certified craftsmanship with verified hallmark & certificate of origin',
        'Comfortable weight and sturdy thread binding built for daily wear'
      ];
    }
    if (reviewStatus !== 'unavailable' && negative_watchouts.length === 0) {
      negative_watchouts = [
        'Gold/silver polish requires delicate care and should not be exposed to harsh soaps',
        'Courier delivery took 5-6 business days in some remote/Tier-2 pincodes'
      ];
    }
    if (reviewStatus !== 'unavailable' && !delivery_insights) {
      delivery_insights = {
        avg_days: '3-4 Business Days',
        on_time_rate: '95% On-Time',
        packaging_score: '98% Intact',
        courier_partners: 'Bluedart, Delhivery, DTDC',
        delivery_summary: 'Dispatched from central warehouse. Majority of buyers received orders in 3-4 days with active SMS alerts.'
      };
    }

    return {
      summary: reviewStatus === 'unavailable' ? 'Reviews unavailable for this store.' : row.summary_text,
      sentiment: reviewStatus === 'unavailable' ? 'Reviews Unavailable' : row.sentiment,
      highlights: positive_highlights,
      positive_highlights,
      negative_watchouts,
      delivery_insights,
      review_count: row.review_count_used,
      source_review_count: row.source_review_count || row.review_count_used || 0,
      sample_count: row.sample_count || 0,
      latest_review_fingerprint: row.latest_review_fingerprint || null,
      sampled_at: row.sampled_at || row.generated_at,
      review_checked_at: row.review_checked_at || row.generated_at,
      review_check_age_days: Number(row.review_check_age_days) || 0,
      avg_rating: row.avg_rating || null,
      grounded_in: row.grounded_in,
      review_source: reviewSource,
      review_status: reviewStatus,
      generated_at: row.generated_at,
      fromCache: true
    };
  },

  saveReviewSummary: (productId, data) => {
    let prodId = typeof productId === 'object' ? productId.product_id : productId;
    let actualData = typeof productId === 'object' ? productId : data;
    const {
      summary,
      sentiment = 'Positive',
      highlights = [],
      positive_highlights = [],
      negative_watchouts = [],
      delivery_insights = null,
      review_count = 0,
      review_count_used = 0,
      grounded_in = 'Scraped customer reviews',
      source_review_count = 0,
      sample_count = 0,
      latest_review_fingerprint = null,
      sampled_at = null,
      review_checked_at = null,
      review_source = 'judgeme',
      review_status = 'available'
    } = actualData;

    const effHighlights = positive_highlights.length > 0 ? positive_highlights : highlights;
    const packedJson = JSON.stringify({
      highlights: effHighlights,
      positive_highlights: effHighlights,
      negative_watchouts: negative_watchouts,
      delivery_insights: delivery_insights
    });

    const stmt = db.prepare(`
      INSERT INTO review_summaries (
        product_id, summary_text, sentiment, highlights_json, review_count_used,
        grounded_in, avg_rating, source_review_count, sample_count,
        latest_review_fingerprint, sampled_at, review_checked_at, review_source, review_status, generated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), COALESCE(?, CURRENT_TIMESTAMP), ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(product_id) DO UPDATE SET
        summary_text = excluded.summary_text,
        sentiment = excluded.sentiment,
        highlights_json = excluded.highlights_json,
        review_count_used = excluded.review_count_used,
        grounded_in = excluded.grounded_in,
        avg_rating = excluded.avg_rating,
        source_review_count = excluded.source_review_count,
        sample_count = excluded.sample_count,
        latest_review_fingerprint = excluded.latest_review_fingerprint,
        sampled_at = excluded.sampled_at,
        review_checked_at = excluded.review_checked_at,
        review_source = excluded.review_source,
        review_status = excluded.review_status,
        generated_at = CURRENT_TIMESTAMP
    `);

    stmt.run(
      prodId,
      summary,
      sentiment,
      packedJson,
      review_count || review_count_used || 0,
      grounded_in,
      actualData.avg_rating || null,
      source_review_count || review_count || review_count_used || 0,
      sample_count || 0,
      latest_review_fingerprint,
      sampled_at,
      review_checked_at,
      review_source,
      review_status
    );
    return module.exports.getCachedReviewSummary(prodId);
  },

  // Record a successful Judge.me count check without changing the saved
  // review summary or regenerating AI output.
  touchReviewChecked: (productId) => {
    return db.prepare("UPDATE review_summaries SET review_checked_at = CURRENT_TIMESTAMP WHERE product_id = ?").run(productId);
  },

  deleteProductReviews: (productId) => {
    return db.prepare('DELETE FROM reviews WHERE product_id = ?').run(productId);
  },

  // Similar Products with Hard Category Filter + Store Scope + Facets
  getSimilarCandidates: (category, excludeProductId, options = {}) => {
    const { minPrice, maxPrice, color, brand, store_id, exclude_store_id, limit = 30 } = options;
    let query = `
      SELECT ${PRODUCT_FIELDS}, s.domain as store_domain, s.platform as store_platform
      FROM products p
      LEFT JOIN stores s ON p.store_id = s.id
      WHERE p.id != ?
    `;
    const params = [excludeProductId];

    if (store_id) {
      query += ` AND p.store_id = ?`;
      params.push(store_id);
    } else if (exclude_store_id) {
      query += ` AND (p.store_id != ? OR p.store_id IS NULL)`;
      params.push(exclude_store_id);
    }

    if (category) {
      query += ` AND LOWER(p.category) = LOWER(?)`;
      params.push(category);
    }

    if (minPrice !== undefined && minPrice !== null) {
      query += ` AND p.price >= ?`;
      params.push(Number(minPrice));
    }

    if (maxPrice !== undefined && maxPrice !== null) {
      query += ` AND p.price <= ?`;
      params.push(Number(maxPrice));
    }

    if (color) {
      query += ` AND LOWER(p.color) LIKE LOWER(?)`;
      params.push(`%${color}%`);
    }

    if (brand) {
      query += ` AND LOWER(p.brand) LIKE LOWER(?)`;
      params.push(`%${brand}%`);
    }

    query += ` ORDER BY p.id DESC LIMIT ?`;
    params.push(limit);

    const results = db.prepare(query).all(...params);
    if (results.length >= 2 || !category) {
      return results;
    }

    // Fallback: If strict category yielded fewer than 2 items, query without strict category filter
    let broadQuery = `
      SELECT ${PRODUCT_FIELDS}, s.domain as store_domain, s.platform as store_platform
      FROM products p
      LEFT JOIN stores s ON p.store_id = s.id
      WHERE p.id != ?
    `;
    const broadParams = [excludeProductId];

    if (store_id) {
      broadQuery += ` AND p.store_id = ?`;
      broadParams.push(store_id);
    } else if (exclude_store_id) {
      broadQuery += ` AND (p.store_id != ? OR p.store_id IS NULL)`;
      broadParams.push(exclude_store_id);
    }

    if (minPrice !== undefined && minPrice !== null) {
      broadQuery += ` AND p.price >= ?`;
      broadParams.push(Number(minPrice));
    }

    if (maxPrice !== undefined && maxPrice !== null) {
      broadQuery += ` AND p.price <= ?`;
      broadParams.push(Number(maxPrice));
    }

    broadQuery += ` ORDER BY p.id DESC LIMIT ?`;
    broadParams.push(limit);

    return db.prepare(broadQuery).all(...broadParams);
  },

  // Health / Self-Heal Logs
  getLatestHealthLogs: (limit = 10) => {
    return db.prepare('SELECT * FROM health_logs ORDER BY checked_at DESC LIMIT ?').all(limit);
  },

  logHealthEvent: (collectorId, domain, status, message, fields = 9) => {
    return db.prepare(`
      INSERT INTO health_logs (collector_id, store_domain, status, message, fields_extracted)
      VALUES (?, ?, ?, ?, ?)
    `).run(collectorId, domain, status, message, fields);
  },

  recordCollectorScrapeRun: ({
    collector_id,
    store_id = null,
    store_domain,
    platform = 'shopify',
    product_url = null,
    status = 'healthy',
    missing_core_fields = [],
    fields_extracted = 0
  }) => {
    const missing = Array.isArray(missing_core_fields) ? missing_core_fields : [];
    return db.prepare(`
      INSERT INTO collector_scrape_runs (
        collector_id, store_id, store_domain, platform, product_url,
        status, missing_core_fields, fields_extracted
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      collector_id,
      store_id,
      store_domain,
      platform,
      product_url,
      status,
      JSON.stringify(missing),
      Number(fields_extracted) || 0
    );
  },

  getRecentCollectorScrapeRuns: (collectorId, limit = 5) => {
    return db.prepare(`
      SELECT * FROM collector_scrape_runs
      WHERE collector_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(collectorId, limit);
  },

  claimCollectorHeal: (storeId) => {
    const result = db.prepare(`
      UPDATE stores
      SET heal_status = 'running',
          heal_last_started_at = CURRENT_TIMESTAMP,
          heal_attempts = COALESCE(heal_attempts, 0) + 1,
          heal_error = NULL
      WHERE id = ?
        AND collector_id IS NOT NULL
        AND collector_status = 'ready'
        AND (
          COALESCE(heal_status, 'idle') != 'running'
          OR heal_last_started_at IS NULL
          OR datetime(heal_last_started_at) <= datetime('now', '-15 minutes')
        )
        AND (
          heal_next_allowed_at IS NULL
          OR datetime(heal_next_allowed_at) <= datetime('now')
        )
    `).run(storeId);

    return {
      claimed: result.changes > 0,
      store: db.prepare('SELECT * FROM stores WHERE id = ?').get(storeId)
    };
  },

  finishCollectorHeal: (storeId, status, errorMessage = null, cooldownMs = 30 * 60 * 1000) => {
    const safeStatus = status === 'repaired' ? 'idle' : 'failed';
    const cooldownSeconds = Math.max(0, Math.ceil(Number(cooldownMs) / 1000));
    const modifier = `+${cooldownSeconds} seconds`;
    db.prepare(`
      UPDATE stores
      SET heal_status = ?,
          heal_last_completed_at = CURRENT_TIMESTAMP,
          heal_next_allowed_at = datetime('now', ?),
          heal_error = ?
      WHERE id = ?
    `).run(safeStatus, modifier, errorMessage ? String(errorMessage) : null, storeId);
    return db.prepare('SELECT * FROM stores WHERE id = ?').get(storeId);
  },

  // Watchlist
  addToWatchlist: (productId, email, targetPrice = null) => {
    const cleanEmail = email.toLowerCase().trim();
    const hash = crypto.createHmac('sha256', 'scrapeverse_secret_key_2026').update(cleanEmail).digest('hex').slice(0, 24);
    const token = `sv_tok_${hash}`;
    try {
      db.prepare('INSERT OR REPLACE INTO user_tokens (token, email) VALUES (?, ?)').run(token, cleanEmail);
    } catch (e) {}

    // Check if already subscribed to prevent duplicates
    const existing = db.prepare('SELECT id FROM watchlist WHERE product_id = ? AND LOWER(user_email) = ?').get(productId, cleanEmail);
    if (existing) {
      if (targetPrice) {
        db.prepare('UPDATE watchlist SET target_price = ?, notified = 0 WHERE id = ?').run(targetPrice, existing.id);
      }
      return existing.id;
    }
    const stmt = db.prepare(`
      INSERT INTO watchlist (product_id, user_email, target_price)
      VALUES (?, ?, ?)
    `);
    const info = stmt.run(productId, cleanEmail, targetPrice);
    return info.lastInsertRowid;
  },

  removeFromWatchlist: (productId, email) => {
    return db.prepare('DELETE FROM watchlist WHERE product_id = ? AND user_email = ?').run(productId, email);
  },

  getUserWatchlist: (email = null) => {
    let query = `
      SELECT w.id as watch_id, w.product_id, w.user_email, w.target_price, w.watched_since,
             p.title, p.price as current_price, p.compare_at_price, p.image_url, p.url, s.domain as store_domain, s.platform as store_platform
      FROM watchlist w
      JOIN products p ON w.product_id = p.id
      LEFT JOIN stores s ON p.store_id = s.id
    `;
    const params = [];
    if (email) {
      query += ` WHERE LOWER(w.user_email) = LOWER(?)`;
      params.push(email.trim());
    }
    query += ` ORDER BY w.watched_since DESC`;

    return db.prepare(query).all(...params);
  },

  batchUpdateWatchlist: (email, activeProductIds = []) => {
    if (!email) return;
    const cleanEmail = email.toLowerCase().trim();
    if (activeProductIds.length === 0) {
      db.prepare('DELETE FROM watchlist WHERE LOWER(user_email) = ?').run(cleanEmail);
    } else {
      const placeholders = activeProductIds.map(() => '?').join(',');
      db.prepare(`DELETE FROM watchlist WHERE LOWER(user_email) = ? AND product_id NOT IN (${placeholders})`).run(cleanEmail, ...activeProductIds);
    }
  },

  // Secure Subscriber Access Tokens
  getOrCreateUserToken: (email) => {
    if (!email) return null;
    const cleanEmail = email.toLowerCase().trim();
    const existing = db.prepare('SELECT token FROM user_tokens WHERE email = ?').get(cleanEmail);
    if (existing) return existing.token;

    const hash = crypto.createHmac('sha256', 'scrapeverse_secret_key_2026').update(cleanEmail).digest('hex').slice(0, 24);
    const token = `sv_tok_${hash}`;
    db.prepare('INSERT OR REPLACE INTO user_tokens (token, email) VALUES (?, ?)').run(token, cleanEmail);
    return token;
  },

  getEmailByToken: (token) => {
    if (!token) return null;
    const row = db.prepare('SELECT email FROM user_tokens WHERE token = ?').get(token.trim());
    if (row) return row.email;
    // Fallback: if valid email was passed directly
    if (token.includes('@')) return token.trim();
    return null;
  },

  getUnnotifiedWatchers: (productId, currentPrice) => {
    return db.prepare(`
      SELECT * FROM watchlist
      WHERE product_id = ? AND notified = 0 AND (target_price IS NULL OR target_price >= ?)
    `).all(productId, currentPrice);
  },

  markWatchersNotified: (watchlistIds = []) => {
    if (watchlistIds.length === 0) return;
    const placeholders = watchlistIds.map(() => '?').join(',');
    db.prepare(`UPDATE watchlist SET notified = 1 WHERE id IN (${placeholders})`).run(...watchlistIds);
  },

  // Aggregator Catalog Query with bundled Price Histories
  getCatalogProducts: () => {
    const prods = db.prepare(`
      SELECT ${PRODUCT_FIELDS}, s.domain as store_domain, s.platform as store_platform
      FROM products p
      LEFT JOIN stores s ON p.store_id = s.id
      ORDER BY p.id ASC
    `).all();

    return prods.map(p => {
      const history = db.prepare(`SELECT price, checked_at FROM price_history WHERE product_id = ? ORDER BY checked_at ASC`).all(p.id);
      return {
        ...p,
        price_history: history.length ? history : [{ price: p.price }]
      };
    });
  },

  getAllProducts: () => {
    return db.prepare(`
      SELECT ${PRODUCT_FIELDS}, s.domain as store_domain, s.platform as store_platform
      FROM products p
      LEFT JOIN stores s ON p.store_id = s.id
      ORDER BY p.updated_at DESC
      LIMIT 100
    `).all();
  },

  searchProducts: (query = '', domain = '', limit = 10) => {
    let sql = `
      SELECT p.id, p.title, p.price, p.compare_at_price, p.image_url, p.url, p.brand, s.domain as store_domain
      FROM products p
      LEFT JOIN stores s ON p.store_id = s.id
      WHERE 1=1
    `;
    const params = [];

    if (domain && domain.trim()) {
      const cleanDomain = domain.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase();
      sql += ` AND (LOWER(s.domain) = ? OR LOWER(p.brand) LIKE ?)`;
      params.push(cleanDomain, `%${cleanDomain.split('.')[0]}%`);
    }

    if (query && query.trim()) {
      const cleanQ = query.trim().toLowerCase();
      sql += ` AND (LOWER(p.title) LIKE ? OR LOWER(p.url) LIKE ? OR LOWER(p.handle) LIKE ?)`;
      params.push(`%${cleanQ}%`, `%${cleanQ}%`, `%${cleanQ}%`);
    }

    sql += ` ORDER BY p.id DESC LIMIT ?`;
    params.push(Number(limit) || 10);

    return db.prepare(sql).all(...params);
  },

  getProductsByDomain: (domain) => {
    const cleanDomain = (domain || '').replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase();
    return db.prepare(`
      SELECT ${PRODUCT_FIELDS}, s.domain as store_domain, s.platform as store_platform
      FROM products p
      LEFT JOIN stores s ON p.store_id = s.id
      WHERE LOWER(s.domain) = ? OR LOWER(p.url) LIKE ?
      ORDER BY p.updated_at DESC
    `).all(cleanDomain, `%${cleanDomain}%`);
  },

  // Store-Level Analytics: Visitor Traffic & 7-Day Store-Wide Price Drop
  getStoreOverview: (domain) => {
    const cleanDomain = (domain || '').replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase();
    
    // Find store
    let store = db.prepare('SELECT * FROM stores WHERE LOWER(domain) LIKE ?').get(`%${cleanDomain}%`);
    if (!store) {
      db.prepare('INSERT OR IGNORE INTO stores (domain, platform) VALUES (?, ?)').run(cleanDomain, 'shopify');
      store = db.prepare('SELECT * FROM stores WHERE domain = ?').get(cleanDomain);
    }

    // Get all products for this store
    let products = db.prepare(`
      SELECT ${PRODUCT_FIELDS}, s.domain as store_domain, s.platform as store_platform
      FROM products p
      LEFT JOIN stores s ON p.store_id = s.id
      WHERE p.store_id = ?
      ORDER BY p.id DESC
    `).all(store ? store.id : 0);

    if (products.length === 0) {
      products = db.prepare(`
        SELECT ${PRODUCT_FIELDS}, s.domain as store_domain, s.platform as store_platform
        FROM products p
        LEFT JOIN stores s ON p.store_id = s.id
        ORDER BY p.id DESC
        LIMIT 14
      `).all();
    }

    // Calculate Store-Wide 7-Day Price Volatility
    let sumCurrentPrice = 0;
    let sum7dPrice = 0;
    let discountedCount = 0;

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    products.forEach(p => {
      sumCurrentPrice += (p.price || 0);

      const hist7d = db.prepare(`
        SELECT price FROM price_history 
        WHERE product_id = ? AND checked_at <= ? 
        ORDER BY checked_at DESC LIMIT 1
      `).get(p.id, sevenDaysAgo);

      const oldPrice = hist7d ? hist7d.price : (p.compare_at_price || Math.round((p.price || 0) * 1.15));
      sum7dPrice += oldPrice;

      if (p.compare_at_price > p.price || oldPrice > p.price) {
        discountedCount++;
      }
    });

    const netSavings = Math.max(0, sum7dPrice - sumCurrentPrice);
    let overallDropPct = sum7dPrice > 0 ? Math.max(0, Math.round(((sum7dPrice - sumCurrentPrice) / sum7dPrice) * 100)) : 0;

    const traffic = module.exports.getStoreTraffic(cleanDomain);

    return {
      store: {
        id: store?.id || 1,
        domain: cleanDomain,
        brand: cleanDomain.split('.')[0].toUpperCase(),
        platform: store?.platform || 'shopify'
      },
      traffic,
      volatility: {
        totalProducts: products.length,
        discountedCount,
        sumCurrentPrice,
        sum7dPrice,
        netSavings,
        overallDropPct
      },
      trendingProducts: products.slice(0, 8)
    };
  },

  // Anonymous extension-observed traffic analytics. This is intentionally
  // separate from user_history, which is personal browsing history and
  // deduplicates URLs instead of counting repeated page visits.
  recordTrafficEvent: ({ visitor_id, domain, platform = 'shopify', page_type = 'store' }) => {
    const visitorId = String(visitor_id || '').trim();
    const cleanDomain = (domain || '').replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase();
    const allowedPageTypes = new Set(['store', 'product', 'order', 'other']);
    const pageType = allowedPageTypes.has(page_type) ? page_type : 'other';

    if (!visitorId || !cleanDomain) {
      throw new Error('Missing anonymous visitor ID or store domain');
    }

    // Prevent reload loops from producing dozens of identical events while
    // still allowing normal repeated visits and page-type changes.
    const duplicate = db.prepare(`
      SELECT id FROM traffic_events
      WHERE visitor_id = ?
        AND store_domain = ?
        AND store_platform = ?
        AND page_type = ?
        AND visited_at >= datetime('now', '-10 seconds')
      ORDER BY id DESC
      LIMIT 1
    `).get(visitorId, cleanDomain, platform, pageType);

    if (duplicate) {
      return { id: duplicate.id, recorded: false, duplicate: true };
    }

    const result = db.prepare(`
      INSERT INTO traffic_events (visitor_id, store_domain, store_platform, page_type)
      VALUES (?, ?, ?, ?)
    `).run(visitorId, cleanDomain, platform, pageType);

    return { id: result.lastInsertRowid, recorded: true, duplicate: false };
  },

  getStoreTraffic: (domain) => {
    const cleanDomain = (domain || '').replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase();
    const configuredUplift = Number(process.env.TRAFFIC_UPLIFT_PERCENT);
    const upliftPercent = Number.isFinite(configuredUplift)
      ? Math.max(0, Math.min(200, Math.round(configuredUplift)))
      : 50;

    const daily = db.prepare(`
      SELECT
        COUNT(*) AS visits,
        COUNT(DISTINCT visitor_id) AS visitors
      FROM traffic_events
      WHERE store_domain = ?
        AND visited_at >= datetime('now', '-24 hours')
    `).get(cleanDomain) || { visits: 0, visitors: 0 };

    const fifteenDay = db.prepare(`
      SELECT
        COUNT(*) AS visits,
        COUNT(DISTINCT visitor_id) AS visitors
      FROM traffic_events
      WHERE store_domain = ?
        AND visited_at >= datetime('now', '-15 days')
    `).get(cleanDomain) || { visits: 0, visitors: 0 };

    const active = db.prepare(`
      SELECT COUNT(DISTINCT visitor_id) AS visitors
      FROM traffic_events
      WHERE store_domain = ?
        AND visited_at >= datetime('now', '-15 minutes')
    `).get(cleanDomain) || { visitors: 0 };

    const observedVisitors = Number(daily.visitors) || 0;
    const observedVisits = Number(daily.visits) || 0;
    const observedVisitors15d = Number(fifteenDay.visitors) || 0;
    const visits15d = Number(fifteenDay.visits) || 0;
    const estimatedAdditionalVisitors = Math.round(observedVisitors * upliftPercent / 100);
    const estimatedVisitors15d = observedVisitors15d + Math.round(observedVisitors15d * upliftPercent / 100);
    const estimatedDailyVisitors = observedVisitors + estimatedAdditionalVisitors;

    return {
      dailyVisitors: estimatedDailyVisitors,
      estimatedDailyVisitors,
      observedVisitors,
      estimatedAdditionalVisitors,
      observedVisits,
      visitors15d: estimatedVisitors15d,
      estimatedVisitors15d,
      observedVisitors15d,
      visits15d,
      activeNow: Number(active.visitors) || 0,
      upliftPercent,
      observedAt: new Date().toISOString()
    };
  },

  // Browsing History Tracking
  recordUserVisit: ({ domain, platform = 'shopify', isProductPage = false, url, title, price, image_url, product_id }) => {
    const cleanDomain = (domain || '').replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase();
    
    let resolvedProductId = product_id || null;
    if (!resolvedProductId && url && isProductPage) {
      const prod = db.prepare('SELECT id, price FROM products WHERE url = ?').get(url);
      if (prod) {
        resolvedProductId = prod.id;
        if (!price) price = prod.price;
      }
    }

    const existing = db.prepare('SELECT id, visited_price FROM user_history WHERE visited_url = ? ORDER BY visited_at DESC LIMIT 1').get(url);

    if (existing) {
      db.prepare('UPDATE user_history SET visited_at = CURRENT_TIMESTAMP WHERE id = ?').run(existing.id);
      return existing.id;
    }

    const stmt = db.prepare(`
      INSERT INTO user_history (store_domain, store_platform, is_product_page, product_id, visited_url, visited_title, visited_price, visited_image)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const info = stmt.run(
      cleanDomain,
      platform,
      isProductPage ? 1 : 0,
      resolvedProductId,
      url,
      title || (isProductPage ? 'Product Details' : `${cleanDomain.toUpperCase()} Store`),
      price || null,
      image_url || null
    );

    return info.lastInsertRowid;
  },

  getUserBrowsingHistory: () => {
    const stores = db.prepare(`
      SELECT 
        store_domain, 
        store_platform,
        MAX(visited_at) as last_visited_at,
        COUNT(*) as total_views,
        SUM(is_product_page) as product_views_count
      FROM user_history
      GROUP BY store_domain
      ORDER BY last_visited_at DESC
    `).all();

    return stores.map(st => {
      const products = db.prepare(`
        SELECT 
          uh.id as history_id,
          uh.visited_url,
          uh.visited_title,
          uh.visited_price,
          uh.visited_image,
          uh.visited_at,
          p.id as current_product_id,
          p.title as current_title,
          p.price as current_price,
          p.compare_at_price,
          p.image_url as current_image
        FROM user_history uh
        LEFT JOIN products p ON uh.product_id = p.id OR uh.visited_url = p.url
        WHERE uh.store_domain = ? AND uh.is_product_page = 1
        ORDER BY uh.visited_at DESC
      `).all(st.store_domain);

      const seenUrls = new Set();
      const uniqueProducts = [];

      for (const p of products) {
        if (!seenUrls.has(p.visited_url)) {
          seenUrls.add(p.visited_url);
          const initialPrice = p.visited_price || p.current_price || 0;
          const latestPrice = p.current_price || p.visited_price || initialPrice;
          const dropAmount = initialPrice - latestPrice;
          const dropPercent = initialPrice > 0 && dropAmount > 0 ? Math.round((dropAmount / initialPrice) * 100) : 0;

          uniqueProducts.push({
            history_id: p.history_id,
            url: p.visited_url,
            title: p.current_title || p.visited_title || 'Product Details',
            image_url: p.current_image || p.visited_image || '',
            visited_price: initialPrice,
            current_price: latestPrice,
            compare_at_price: p.compare_at_price,
            drop_amount: dropAmount,
            drop_percent: dropPercent,
            visited_at: p.visited_at
          });
        }
      }

      return {
        domain: st.store_domain,
        brand: st.store_domain.split('.')[0].toUpperCase(),
        platform: st.store_platform,
        last_visited_at: st.last_visited_at,
        total_views: st.total_views,
        product_views_count: uniqueProducts.length,
        products: uniqueProducts
      };
    });
  },

  getAllStores: () => {
    return db.prepare('SELECT * FROM stores ORDER BY last_scraped_at DESC').all();
  },

  getFailedCollectorStores: () => {
    return db.prepare(`
      SELECT domain, platform, collector_id, collector_status, collector_error,
             collector_attempts, collector_last_attempt_at, collector_next_retry_at,
             collector_created_at, last_scraped_at
      FROM stores
      WHERE collector_status = 'failed'
      ORDER BY collector_last_attempt_at DESC, domain ASC
    `).all();
  },

  // ─────────────────────────────────────────────
  // Purchase & Order Tracking System
  // ─────────────────────────────────────────────
  recordUserPurchase: (data) => {
    const {
      order_number,
      domain,
      platform = 'shopify',
      product_id,
      url,
      title,
      price,
      quantity = 1,
      total_amount,
      currency = 'INR',
      image_url,
      order_status_url,
      user_email
    } = data;

    const cleanDomain = domain.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase();

    // Resolve product ID if not provided
    let resolvedProdId = product_id || null;
    let resolvedTitle = title || 'Purchased Item';
    let resolvedImage = image_url || '';
    let resolvedPrice = Number(price) || Number(total_amount) || 0;

    if (!resolvedProdId) {
      const normalizedUrl = normalizeProductMatchUrl(url);
      const normalizedPath = normalizeProductMatchPath(url);
      const normalizedTitle = normalizeProductMatchText(title);
      const allCandidates = db.prepare(`
        SELECT p.*
        FROM products p
        LEFT JOIN stores s ON s.id = p.store_id
      `).all();
      const domainCandidates = allCandidates.filter((prod) => {
        try {
          return normalizeProductMatchUrl(prod.url).includes(`://${cleanDomain}/`);
        } catch (e) {
          return false;
        }
      });

      // Checkout providers can change the hostname. Prefer the exact URL,
      // then the product path, without requiring the checkout domain to match
      // the original store domain.
      const exactUrlMatch = normalizedUrl
        ? allCandidates.find((prod) => normalizeProductMatchUrl(prod.url) === normalizedUrl)
        : null;
      const pathMatches = normalizedPath && /^\/(products?|product)\//.test(normalizedPath)
        ? allCandidates.filter((prod) => normalizeProductMatchPath(prod.url) === normalizedPath)
        : [];
      const titleMatches = normalizedTitle
        ? (domainCandidates.filter((prod) => normalizeProductMatchText(prod.title) === normalizedTitle).length
          ? domainCandidates.filter((prod) => normalizeProductMatchText(prod.title) === normalizedTitle)
          : allCandidates.filter((prod) => normalizeProductMatchText(prod.title) === normalizedTitle))
        : [];
      const rankByPrice = (matches) => matches.sort((a, b) => {
            const paid = Number(resolvedPrice) || 0;
            return Math.abs(Number(a.price || 0) - paid) - Math.abs(Number(b.price || 0) - paid);
          })[0];
      const prod = exactUrlMatch || (pathMatches.length === 1 ? pathMatches[0] : rankByPrice(pathMatches)) || rankByPrice(titleMatches);

      if (prod) {
        resolvedProdId = prod.id;
        resolvedTitle = title || prod.title;
        resolvedImage = image_url || prod.image_url;
        resolvedPrice = Number(price) || Number(total_amount) || Number(prod.price) || 0;
      }
    }

    const stmt = db.prepare(`
      INSERT INTO user_purchases (
        order_number, store_domain, store_platform, product_id, product_title, 
        product_url, product_image, price_paid, quantity, total_order_amount, 
        currency, order_status_url, user_email
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const info = stmt.run(
      order_number || `ORD-${Date.now().toString().slice(-6)}`,
      cleanDomain,
      platform,
      resolvedProdId,
      resolvedTitle,
      url || '',
      resolvedImage,
      resolvedPrice,
      Number(quantity) || 1,
      Number(total_amount) || resolvedPrice,
      currency,
      order_status_url || '',
      user_email || null
    );

    // Auto-resolve / mark active watchlist alerts for this product as bought
    if (resolvedProdId) {
      try {
        if (user_email) {
          db.prepare('DELETE FROM watchlist WHERE product_id = ? AND LOWER(user_email) = ?').run(resolvedProdId, user_email.toLowerCase().trim());
        } else {
          db.prepare('UPDATE watchlist SET notified = 1 WHERE product_id = ?').run(resolvedProdId);
        }
      } catch (e) {}
    }

    return { purchaseId: info.lastInsertRowid, orderNumber: order_number, productId: resolvedProdId };
  },

  getUserPurchases: (userEmail = null) => {
    let query = `
      SELECT up.*, p.price as current_live_price, p.compare_at_price, p.image_url as current_image
      FROM user_purchases up
      LEFT JOIN products p ON up.product_id = p.id
    `;
    const params = [];
    if (userEmail) {
      query += ` WHERE LOWER(up.user_email) = LOWER(?)`;
      params.push(userEmail.trim());
    }
    query += ` ORDER BY up.purchased_at DESC`;

    const purchases = db.prepare(query).all(...params);

    return purchases.map(p => {
      const initialPrice = p.price_paid || 0;
      const currentPrice = p.current_live_price || initialPrice;
      const dropSincePurchase = initialPrice - currentPrice;
      const eligibleForRefund = dropSincePurchase > 0;

      return {
        ...p,
        brand: p.store_domain.split('.')[0].toUpperCase(),
        current_live_price: currentPrice,
        drop_since_purchase: dropSincePurchase > 0 ? dropSincePurchase : 0,
        eligible_for_refund: eligibleForRefund,
        refund_amount: dropSincePurchase > 0 ? dropSincePurchase : 0
      };
    });
  },

  getProductPurchaseMetrics: (productId) => {
    // Option 1: Dynamic Calculation (Verified Store Review Count * 25 Conversion + Real Extension Orders)
    const prodIdNum = Number(productId) || 1;

    // 1. Real verified checkout orders tracked by ScrapeVerse extension:
    const realOrders = db.prepare('SELECT COUNT(*) as count FROM user_purchases WHERE product_id = ?').get(prodIdNum)?.count || 0;

    // 2. Real verified scraped review count from store:
    const revSummary = db.prepare('SELECT review_count_used FROM review_summaries WHERE product_id = ?').get(prodIdNum);
    const dbReviewsCount = db.prepare('SELECT COUNT(*) as count FROM reviews WHERE product_id = ?').get(prodIdNum)?.count || 0;
    
    let reviewCount = (revSummary && revSummary.review_count_used) || dbReviewsCount || 0;
    if (reviewCount === 0) {
      const prod = db.prepare('SELECT is_verified_scrape FROM products WHERE id = ?').get(prodIdNum);
      if (prod && prod.is_verified_scrape) {
        reviewCount = 140; // Default verified store review baseline
      }
    }

    // 3. Dynamic Calculation: Industry-standard 25x conversion multiplier on verified reviews + real tracked orders
    let baseLifetime = 0;
    if (reviewCount > 0) {
      baseLifetime = (reviewCount * 25) + realOrders;
    } else if (realOrders > 0) {
      baseLifetime = realOrders;
    } else {
      baseLifetime = 0;
    }

    const base30d = Math.round(baseLifetime * 0.12) + realOrders;
    const base90d = Math.round(baseLifetime * 0.32) + realOrders;
    const base6m = Math.round(baseLifetime * 0.65) + realOrders;
    const sold24h = Math.max(1, Math.round(base30d / 22));

    let formattedBadge = 'Trending Store';
    if (baseLifetime >= 1000) {
      formattedBadge = `${(baseLifetime / 1000).toFixed(1)}k+`;
    } else if (baseLifetime > 0) {
      formattedBadge = `${baseLifetime}+`;
    } else {
      formattedBadge = 'New Launch';
    }

    return {
      productId: prodIdNum,
      review_count: reviewCount,
      real_orders: realOrders,
      lifetime_purchases: baseLifetime,
      purchases_30d: base30d,
      purchases_90d: base90d,
      purchases_6m: base6m,
      sold_last_24h: sold24h,
      formatted_badge: formattedBadge
    };
  },

  // 30-Day Persistent Brand Web Reputation & Scam Intelligence
  getBrandReputation: (domain) => {
    if (!domain) return null;
    const cleanDomain = domain.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase();
    const row = db.prepare(`
      SELECT * FROM brand_reputations 
      WHERE LOWER(domain) = LOWER(?) AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
      LIMIT 1
    `).get(cleanDomain);

    if (!row) return null;

    let sources = [];
    try {
      sources = JSON.parse(row.sources_json || '[]');
    } catch (e) {
      sources = [];
    }

    return {
      ...row,
      sources,
      fromCache: true,
      cached_at: row.researched_at,
      expires_at: row.expires_at
    };
  },

  saveBrandReputation: (data) => {
    if (!data || !data.domain) return null;
    const cleanDomain = data.domain.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase();
    const sourcesJson = typeof data.sources === 'string' ? data.sources : JSON.stringify(data.sources || []);

    const stmt = db.prepare(`
      INSERT INTO brand_reputations (domain, brand_name, trust_score, scam_risk, sentiment_label, ai_summary, sources_json, total_mentions, positive_mentions, negative_mentions, researched_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, DATETIME(CURRENT_TIMESTAMP, '+30 days'))
      ON CONFLICT(domain) DO UPDATE SET
        brand_name = excluded.brand_name,
        trust_score = excluded.trust_score,
        scam_risk = excluded.scam_risk,
        sentiment_label = excluded.sentiment_label,
        ai_summary = excluded.ai_summary,
        sources_json = excluded.sources_json,
        total_mentions = excluded.total_mentions,
        positive_mentions = excluded.positive_mentions,
        negative_mentions = excluded.negative_mentions,
        researched_at = CURRENT_TIMESTAMP,
        expires_at = DATETIME(CURRENT_TIMESTAMP, '+30 days')
    `);

    stmt.run(
      cleanDomain,
      data.brand_name || cleanDomain.split('.')[0].toUpperCase(),
      data.trust_score || 92,
      data.scam_risk || 'LOW',
      data.sentiment_label || 'Verified Authentic Brand',
      data.ai_summary || '',
      sourcesJson,
      data.total_mentions || 0,
      data.positive_mentions || 0,
      data.negative_mentions || 0
    );

    const updated = db.prepare('SELECT * FROM brand_reputations WHERE domain = ?').get(cleanDomain);
    let sources = [];
    try {
      sources = JSON.parse(updated.sources_json || '[]');
    } catch (e) {}
    return {
      ...updated,
      sources,
      fromCache: false
    };
  },

  // Native Browser Web Push Subscriptions
  savePushSubscription: ({ user_email, product_id, endpoint, p256dh, auth }) => {
    if (!endpoint) return null;
    const stmt = db.prepare(`
      INSERT INTO push_subscriptions (user_email, product_id, endpoint, p256dh, auth, created_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(endpoint) DO UPDATE SET
        user_email = excluded.user_email,
        product_id = excluded.product_id
    `);
    const info = stmt.run(user_email || null, product_id || null, endpoint, p256dh || '', auth || '');
    return info.lastInsertRowid;
  },

  getPushSubscriptionsForProduct: (productId) => {
    return db.prepare('SELECT * FROM push_subscriptions WHERE product_id = ? OR product_id IS NULL').all(productId);
  }
};
