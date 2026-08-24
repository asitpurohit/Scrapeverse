-- ScrapeVerse PostgreSQL schema for Supabase.
-- JSON payloads remain TEXT initially so the application can migrate without
-- changing its existing serialization and parsing behavior.

CREATE TABLE IF NOT EXISTS stores (
  id BIGSERIAL PRIMARY KEY,
  domain TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'shopify',
  collector_id TEXT,
  collector_status TEXT NOT NULL DEFAULT 'missing',
  collector_error TEXT,
  collector_attempts INTEGER DEFAULT 0,
  collector_next_retry_at TIMESTAMPTZ,
  collector_last_attempt_at TIMESTAMPTZ,
  collector_created_at TIMESTAMPTZ,
  heal_status TEXT NOT NULL DEFAULT 'idle',
  heal_last_started_at TIMESTAMPTZ,
  heal_last_completed_at TIMESTAMPTZ,
  heal_next_allowed_at TIMESTAMPTZ,
  heal_attempts INTEGER DEFAULT 0,
  heal_error TEXT,
  last_scraped_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(domain, platform)
);

CREATE TABLE IF NOT EXISTS products (
  id BIGSERIAL PRIMARY KEY,
  store_id BIGINT REFERENCES stores(id),
  product_id TEXT NOT NULL,
  url TEXT UNIQUE NOT NULL,
  handle TEXT,
  title TEXT NOT NULL,
  description TEXT,
  category TEXT,
  brand TEXT,
  price DOUBLE PRECISION NOT NULL,
  compare_at_price DOUBLE PRECISION,
  currency TEXT DEFAULT 'INR',
  color TEXT,
  image_url TEXT,
  is_verified_scrape BOOLEAN DEFAULT TRUE,
  source TEXT DEFAULT 'Bright Data Scraper Studio',
  ai_category TEXT,
  embedding_json TEXT,
  latest_data TEXT,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS price_history (
  id BIGSERIAL PRIMARY KEY,
  product_id BIGINT NOT NULL REFERENCES products(id),
  price DOUBLE PRECISION NOT NULL,
  currency TEXT DEFAULT 'INR',
  checked_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS reviews (
  id BIGSERIAL PRIMARY KEY,
  product_id BIGINT NOT NULL REFERENCES products(id),
  review_text TEXT NOT NULL,
  author TEXT,
  rating DOUBLE PRECISION,
  review_fingerprint TEXT UNIQUE,
  checked_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS review_summaries (
  id BIGSERIAL PRIMARY KEY,
  product_id BIGINT UNIQUE NOT NULL REFERENCES products(id),
  summary_text TEXT NOT NULL,
  sentiment TEXT NOT NULL,
  highlights_json TEXT,
  review_count_used INTEGER DEFAULT 0,
  grounded_in TEXT,
  avg_rating DOUBLE PRECISION,
  source_review_count INTEGER DEFAULT 0,
  sample_count INTEGER DEFAULT 0,
  latest_review_fingerprint TEXT,
  sampled_at TIMESTAMPTZ,
  review_checked_at TIMESTAMPTZ,
  review_source TEXT DEFAULT 'judgeme',
  review_status TEXT DEFAULT 'available',
  generated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS health_logs (
  id BIGSERIAL PRIMARY KEY,
  collector_id TEXT,
  store_domain TEXT,
  status TEXT NOT NULL,
  message TEXT NOT NULL,
  fields_extracted INTEGER DEFAULT 9,
  checked_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS collector_scrape_runs (
  id BIGSERIAL PRIMARY KEY,
  collector_id TEXT NOT NULL,
  store_id BIGINT REFERENCES stores(id),
  store_domain TEXT NOT NULL,
  platform TEXT NOT NULL,
  product_url TEXT,
  status TEXT NOT NULL,
  missing_core_fields TEXT NOT NULL DEFAULT '[]',
  fields_extracted INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS watchlist (
  id BIGSERIAL PRIMARY KEY,
  product_id BIGINT NOT NULL REFERENCES products(id),
  user_id TEXT,
  user_email TEXT NOT NULL,
  target_price DOUBLE PRECISION,
  watched_since TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  notified BOOLEAN DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS user_history (
  id BIGSERIAL PRIMARY KEY,
  visitor_id TEXT,
  store_domain TEXT NOT NULL,
  store_platform TEXT DEFAULT 'shopify',
  is_product_page BOOLEAN DEFAULT FALSE,
  product_id BIGINT REFERENCES products(id),
  visited_url TEXT NOT NULL,
  visited_title TEXT,
  visited_price DOUBLE PRECISION,
  visited_image TEXT,
  visited_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS traffic_events (
  id BIGSERIAL PRIMARY KEY,
  visitor_id TEXT NOT NULL,
  store_domain TEXT NOT NULL,
  store_platform TEXT DEFAULT 'shopify',
  page_type TEXT NOT NULL DEFAULT 'store',
  visited_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_tokens (
  token TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_purchases (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT,
  order_number TEXT,
  store_domain TEXT NOT NULL,
  store_platform TEXT DEFAULT 'shopify',
  product_id BIGINT REFERENCES products(id),
  product_title TEXT NOT NULL,
  product_url TEXT,
  product_image TEXT,
  price_paid DOUBLE PRECISION NOT NULL,
  quantity INTEGER DEFAULT 1,
  total_order_amount DOUBLE PRECISION,
  currency TEXT DEFAULT 'INR',
  order_status_url TEXT,
  user_email TEXT,
  purchased_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS brand_reputations (
  id BIGSERIAL PRIMARY KEY,
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
  researched_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ DEFAULT (CURRENT_TIMESTAMP + INTERVAL '30 days')
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id BIGSERIAL PRIMARY KEY,
  user_email TEXT,
  product_id BIGINT REFERENCES products(id),
  endpoint TEXT UNIQUE NOT NULL,
  p256dh TEXT,
  auth TEXT,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_traffic_events_domain_time
  ON traffic_events (store_domain, visited_at);
CREATE INDEX IF NOT EXISTS idx_traffic_events_visitor_domain_time
  ON traffic_events (visitor_id, store_domain, visited_at);
CREATE INDEX IF NOT EXISTS idx_products_store_id ON products (store_id);
CREATE INDEX IF NOT EXISTS idx_reviews_product_id ON reviews (product_id);
CREATE INDEX IF NOT EXISTS idx_history_visitor ON user_history (visitor_id, visited_at);
