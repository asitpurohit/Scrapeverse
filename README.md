# ScrapeVerse

## The one-line pitch

ScrapeVerse is a Chrome shopping companion that brings verified product data, price history, review intelligence, brand reputation, and collector health signals directly onto e-commerce product pages.

It combines a Manifest V3 browser extension with an Express backend, Bright Data Web Unlocker, Bright Data Scraper Studio, Judge.me review extraction, live web search, an optional LLM analysis layer, and a persistent SQLite data model.

## Hackathon demo

- Live backend and marketing page: <https://scrapeverse.onrender.com>
- Self-healing test store: <https://jolly-crepe-84310b.netlify.app/>
- History hub: <https://scrapeverse.onrender.com/history>
- Developer dashboard: <https://scrapeverse.onrender.com/admin>

The Netlify store is useful for demonstrating the collector lifecycle and self-healing behavior. Install or load the extension, open the demo store, and visit a product page.

## What problem it solves

Online shoppers usually have to make a decision using fragmented signals:

- product information is inconsistent across stores;
- prices have no context or history;
- reviews are difficult to compare and summarize;
- a brand's reputation is disconnected from the product page;
- scraper failures are often silent or require an engineer to repair them.

ScrapeVerse puts these signals beside the product while keeping the store's original page intact.

## Core experience

On a supported product page, the extension can show:

- verified product title, price, currency, brand, category, image, and description;
- current price versus saved price history;
- a lightweight price trend view;
- Judge.me review count, rating, sampled reviews, and an AI-generated balanced summary;
- positive highlights, negative watch-outs, delivery signals, and review grounding;
- brand reputation based on live public-web search results;
- scam-risk and trust indicators;
- similar products ranked from the saved product catalog;
- collector readiness, health, retry, and self-healing status;
- shopping history, purchases, and price-drop alerts.

## Architecture

```text
Shopper visits a store page
          |
          v
Chrome extension (content script + service worker)
          |
          | local-first: http://localhost:3001
          | fallback:   https://scrapeverse.onrender.com
          v
Express backend
  |       |        |          |             |
  v       v        v          v             v
SQLite  Bright   Judge.me   LLM        Email alerts
        Data      reviews   analysis   via Resend
        |         |
        |         +--> Web Unlocker fetches product HTML/widget data
        +--> Store-specific Scraper Studio collectors
             +--> automatic self-healing after extraction failures
```

### Repository layout

```text
backend/
  server.js           Express routes, pages, orchestration, health APIs
  db.js               SQLite schema, migrations, queries, history, alerts
  brightdata.js       collectors, Web Unlocker, Judge.me, search, healing
  product-recheck.js  cached product rechecks and price updates
  price-alerts.js     price-drop notification workflow
  cron.js             background recheck worker
  email.js            Resend email delivery
  public/             marketing page, history UI, admin UI, CSS, browser JS

extension/
  content.js          product-page detection, injected UI, API orchestration
  background.js       service-worker relay and backend selection
  popup.html/js       extension popup and health status
  backend-config.js   local backend plus Render fallback configuration
  content.css         injected companion styling
  manifest.json       Manifest V3 permissions and content-script wiring
```

## Product scrape flow

1. The content script detects a product page and identifies the store domain and platform.
2. It sends the product URL, platform, visitor identifier, and page hints to `POST /api/scrape`.
3. The backend normalizes the domain and creates or loads the store record.
4. On a first visit, the backend provisions a store-specific Bright Data Scraper Studio collector if one does not exist.
5. The API returns a `202 collector_provisioning` response while the collector is being created. The extension polls status and keeps the user informed.
6. Once ready, the collector extracts the core product fields.
7. The backend validates product ID, title, price, and currency before saving the result.
8. The product and price observation are persisted to SQLite.
9. The extension receives the verified product response immediately.
10. Enrichment runs in the background so review and reputation work does not block the first product response.

For revisits, ScrapeVerse serves a cached product within the 24-hour product cooldown. A recheck can refresh product name, price, and compare-at price without repeating the full first-visit flow.

### Bright Data Scraper Studio collectors

ScrapeVerse creates one persistent collector per store/platform combination. The collector prompt requires a stable product schema including:

```text
product_id
product_title
active_price
compare_at_price
currency
brand
image_url
description
category
```

The backend normalizes collector output, including currency values and common nested price formats, then records the collector ID, status, attempts, errors, and scrape observations in the database.

This makes the scraper store-aware instead of relying on one fragile selector set for every website.

## Automatic collector self-healing

Self-healing is an internal recovery path, not a manual judge-only button.

1. A ready collector runs against a product page.
2. The result is checked for required core fields.
3. Missing product ID, title, price, currency, or an explicit provider parse error is recorded as an incomplete collector result.
4. The backend stores the failure, missing fields, attempt count, cooldown, and health event.
5. It fetches fresh page evidence through Bright Data Web Unlocker.
6. It builds a focused repair prompt containing the missing fields, target URL, and page evidence.
7. Bright Data Scraper Studio is asked to heal the existing collector with automatic approval and bounded retries.
8. The extension receives live statuses such as provisioning, scraping, self-healing, healed, retrying, or failed.
9. The next product request retries the repaired collector without requiring a code deploy.

The health model is persisted in the `stores` and `health_logs` tables, including collector status, heal status, last attempt, next allowed retry, error text, and attempt counters. This is visible through the developer dashboard and health endpoints.

## Judge.me review intelligence

For Shopify product pages, the backend uses Bright Data Web Unlocker to fetch the product HTML and detect Judge.me markers. It reads the total review count and average rating, extracts the Judge.me widget product/shop identifiers, and requests paginated widget results from:

```text
https://api.judge.me/reviews/reviews_for_widget
```

The extractor:

- fetches at most the configured review sample limit;
- deduplicates reviews by review ID or normalized author/text;
- preserves total count and average rating separately from the sample;
- records whether reviews are available, incomplete, unavailable, or failed;
- stores the latest review fingerprint and check timestamps.

The LLM layer then produces a balanced summary with positive signals, negative watch-outs, delivery observations when present, sentiment, and explicit grounding such as total reviews versus sampled reviews. The summary is cached and refreshed independently from the product price check.

## Brand reputation query search

Brand reputation is a separate enrichment path from product scraping.

1. The extension sends the normalized store domain and detected brand name to `POST /api/brand-reputation`.
2. The backend checks the 30-day reputation cache first.
3. On a cache miss, Bright Data Search queries the public web using a combined brand/domain query covering reviews, Reddit, YouTube, and Trustpilot.
4. The backend selects the most relevant organic results and sends their titles, sources, URLs, and snippets to the configured LLM.
5. The LLM returns a structured trust score, scam risk, sentiment label, objective summary, mention counts, and source cards.
6. The result is cached by normalized domain for later visitors.

The reputation feature is designed to show evidence and source links rather than presenting an unexplained score. The system also contains a deterministic demo path for clearly simulated scam-style domains so the risk UI can be tested without relying on live search results.

## Data and persistence

The backend uses SQLite with tables for:

- stores and store-specific collector state;
- products and price history;
- reviews and review summaries;
- collector scrape runs and health logs;
- user history and traffic events;
- purchases;
- watchlists and price alerts;
- user email tokens and reputation cache.

Local development defaults to:

```text
backend/scrape_verse.db
```

Render production uses:

```text
SQLITE_DB_PATH=/var/data/scrape_verse.db
```

with a persistent Render disk mounted at `/var/data`. Without a persistent disk, a Render restart can remove SQLite data.

## Local development

Requirements:

- Node.js 22 or newer;
- Bright Data API access for live scraping and collector workflows;
- optional LLM and Resend credentials for enrichment and email alerts.

Start the backend:

```bash
cd backend
npm install
npm start
```

The local backend runs at <http://localhost:3001> by default.

Load the extension:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the `extension/` directory.
5. Open a supported store product page.

The extension uses localhost first and automatically falls back to Render when the local health check is unavailable. This lets judges test the public deployment without requiring a local server, while developers can work offline against their local backend.

## Render deployment

Create a Render **Web Service** connected to this GitHub repository:

```text
Root Directory: backend
Build Command: npm install
Start Command: npm start
Health Check Path: /api/health-status
```

Recommended environment variables:

```text
NODE_VERSION=22
BRIGHTDATA_API_KEY=<secret>
LLM_BASE_URL=<optional>
LLM_API_KEY=<secret>
LLM_MODEL=<optional>
LLM_PROVIDER=<provider>
RESEND_API_KEY=<secret>
RESEND_FROM_EMAIL=ScrapeVerse Alerts <sender>
SQLITE_DB_PATH=/var/data/scrape_verse.db
```

Never commit `.env`, API keys, or SQLite files. Use Render Environment Variables or a secret file. The repository contains only `.env.example` as a safe template.

## Useful routes

### Pages

| Route | Purpose |
|---|---|
| `/` | Marketing homepage |
| `/history` | Shopping history, purchases, and alerts hub |
| `/homepage` | History-compatible route for the existing extension link |
| `/price-history?url=...` | Product price history page |
| `/admin` | Developer and judge dashboard |
| `/admin/brand-catalog` | Catalog and brand view |
| `/admin/collector-failures` | Collector failure and healing view |

### Key APIs

| Endpoint | Purpose |
|---|---|
| `POST /api/scrape` | Provision collectors, scrape/cache products, return price history |
| `GET /api/store-collector-status` | Store collector readiness and provisioning state |
| `GET /api/collector-health-status` | Self-healing and collector health status |
| `GET /api/enrichment-status` | Background brand/review enrichment status |
| `POST /api/brand-reputation` | Query and cache public-web reputation intelligence |
| `GET /api/brand-reputation-cache` | Read cached reputation data |
| `POST /api/review-summary` | Fetch Judge.me reviews and generate summary |
| `POST /api/similar` | Find catalog products with a lightweight similarity ranker |
| `POST /api/history/track` | Track store/product visits |
| `GET /api/history` | Read visitor history |
| `POST /api/watchlist` | Create a price alert |
| `POST /api/purchases/track` | Track a purchase |
| `GET /api/health-status` | Deployment and enrichment health check |
| `POST /api/cron/trigger` | Trigger a controlled background recheck |

## Suggested judge walkthrough

1. Open the marketing page to understand the product promise.
2. Load the extension and open the Netlify self-heal test store.
3. Visit a product page and watch collector provisioning status.
4. Inspect the verified product panel and price trend.
5. Open the reputation view to see the brand query path and source cards.
6. Open the review intelligence panel on a Shopify store with Judge.me.
7. Visit the history hub to see the tracked product and store.
8. Open `/admin` to inspect stores, products, collector health, enrichment, alerts, and background jobs.
9. Use `/admin/collector-failures` or the self-heal demo to observe failed-field detection and recovery states.

## Design and engineering choices

- **Cache first:** product data, price history, reviews, and reputation have independent cache policies to reduce redundant network calls.
- **Async enrichment:** the basic product response is returned before slower LLM, review, and reputation enrichment completes.
- **Per-store collectors:** each store receives a collector adapted to its page structure.
- **Observable recovery:** collector failures and self-healing are stored and exposed instead of disappearing in logs.
- **Local-first development:** local testing remains fast and can work without internet; the public extension falls back to Render.
- **Secrets stay server-side:** the extension contains backend URLs, not Bright Data, LLM, or Resend credentials.

## Known limitations

- Live scraping and LLM enrichment require valid provider credentials and can take longer on a first visit.
- Judge.me extraction is specific to stores exposing Judge.me widget markers and Shopify product metadata.
- SQLite on Render requires a persistent disk for durable production data.
- Public deployment should add stronger authentication, rate limiting, and usage controls before broad commercial release.
- The extension is currently distributed as an unpacked Chrome extension; Chrome Web Store packaging and review are separate release steps.

## License

This repository is currently a hackathon/demo project. Add the intended license before public redistribution.
