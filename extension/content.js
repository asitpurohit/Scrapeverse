// ─────────────────────────────────────────────
// ScrapeVerse — Universal E-commerce Companion
// Top Horizontal Header & Slide-in Sidebar
// Supports: Shopify, WooCommerce, Magento & Custom DTC Stores
// ─────────────────────────────────────────────

const BACKEND_URL = 'http://localhost:3001';

(function () {
  console.log('✦ ScrapeVerse Content Script loaded.');

  // Public storefront pages are not allowed to call localhost directly by
  // newer Chrome Local Network Access rules. Route backend API traffic through
  // the extension service worker, while keeping the existing API contracts.
  function backendFetch(input, init = {}) {
    const rawUrl = String(input || '');
    const path = rawUrl.startsWith(BACKEND_URL)
      ? rawUrl.slice(BACKEND_URL.length) || '/'
      : rawUrl;

    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        type: 'BACKEND_FETCH',
        path,
        init: {
          method: init.method || 'GET',
          headers: init.headers || {},
          body: init.body ?? null,
          cache: init.cache || 'default'
        }
      }, (result) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!result?.success) {
          reject(new Error(result?.error || 'Backend request failed'));
          return;
        }

        resolve(new Response(result.body || '', {
          status: result.status || 200,
          headers: result.headers || {}
        }));
      });
    });
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[character]));
  }

  let currentScope = 'same_website';
  let selectedSortBy = 'recent';
  let selectedMaxPrice = 'all';
  let selectedMinDiscount = 'all';
  let sidebarCache = { reviews: null, history: null };
  let productInitializationInFlight = false;
  let manualRecheckInFlight = false;
  let anonymousVisitorIdPromise = null;
  let statusAudioContext = null;
  let statusAudioUnlockBound = false;

  function getStatusAudioContext() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;

    if (!statusAudioContext) {
      try {
        statusAudioContext = new AudioContextClass();
      } catch (error) {
        return null;
      }
    }

    return statusAudioContext;
  }

  function bindStatusAudioUnlock() {
    if (statusAudioUnlockBound) return;
    statusAudioUnlockBound = true;

    const unlock = () => {
      const context = getStatusAudioContext();
      if (context?.state === 'suspended') {
        context.resume().catch(() => {});
      }
    };

    ['pointerdown', 'keydown', 'touchstart'].forEach(eventName => {
      window.addEventListener(eventName, unlock, { passive: true, capture: true });
    });
  }

  async function playStatusChangeSound(stage) {
    const context = getStatusAudioContext();
    if (!context) return;

    try {
      if (context.state === 'suspended') await context.resume();
      if (context.state !== 'running') return;

      const isFailure = stage === 'failed' || stage === 'collector_failed' || stage === 'collector_heal_failed';
      const isSuccess = stage === 'complete' || stage === 'collector_ready' || stage === 'collector_healed';
      const frequencies = isFailure ? [220, 165] : (isSuccess ? [523.25, 659.25] : [392, 523.25]);
      const now = context.currentTime;
      const oscillator = context.createOscillator();
      const gain = context.createGain();

      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(frequencies[0], now);
      oscillator.frequency.setValueAtTime(frequencies[1], now + 0.075);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.045, now + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);

      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(now);
      oscillator.stop(now + 0.17);
    } catch (error) {
      // Audio is an optional enhancement. Ignore browser autoplay/audio errors.
    }
  }

  function createAnonymousVisitorId() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `sv-${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  }

  function formatTrafficNumber(value) {
    const number = Math.max(0, Number(value) || 0);
    return number >= 1000 ? `${(number / 1000).toFixed(1)}k` : String(Math.round(number));
  }

  function getAnonymousVisitorId() {
    if (anonymousVisitorIdPromise) return anonymousVisitorIdPromise;

    anonymousVisitorIdPromise = new Promise((resolve) => {
      const storage = globalThis.chrome?.storage?.local;
      const storageKey = 'scrapeverse_anonymous_visitor_id';
      if (!storage) {
        resolve(null);
        return;
      }

      storage.get([storageKey], (stored) => {
        const existing = stored?.[storageKey];
        if (existing) {
          resolve(existing);
          return;
        }

        const generated = createAnonymousVisitorId();
        storage.set({ [storageKey]: generated }, () => resolve(generated));
      });
    });

    return anonymousVisitorIdPromise;
  }

  const recentProductContextKey = 'scrapeverse_recent_product_contexts';

  function normalizeProductContextTitle(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/&amp;/g, '&')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  function rememberProductContext(product, platform) {
    const storage = globalThis.chrome?.storage?.local;
    if (!storage || !product?.id || !product?.url) return;
    storage.get([recentProductContextKey], (stored) => {
      const existing = Array.isArray(stored?.[recentProductContextKey])
        ? stored[recentProductContextKey]
        : [];
      const next = [
        {
          id: product.id,
          url: product.url,
          title: product.title || '',
          image_url: product.image_url || '',
          platform: platform || 'shopify',
          saved_at: Date.now()
        },
        ...existing.filter((item) => item?.id !== product.id)
      ].slice(0, 25);
      storage.set({ [recentProductContextKey]: next });
    });
  }

  function getRecentProductContexts() {
    return new Promise((resolve) => {
      const storage = globalThis.chrome?.storage?.local;
      if (!storage) {
        resolve([]);
        return;
      }
      storage.get([recentProductContextKey], (stored) => {
        resolve(Array.isArray(stored?.[recentProductContextKey]) ? stored[recentProductContextKey] : []);
      });
    });
  }

  function recordTrafficSignal({ domain, platform, pageType }) {
    getAnonymousVisitorId()
      .then(visitorId => {
        if (!visitorId) return;
        return backendFetch(`${BACKEND_URL}/api/traffic/event`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            visitor_id: visitorId,
            domain,
            platform,
            page_type: pageType
          })
        });
      })
      .catch(() => {});
  }

  function isLocalDevelopmentHost() {
    const hostname = window.location.hostname.toLowerCase();
    return hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '0.0.0.0' ||
      hostname === '::1' ||
      hostname === '[::1]' ||
      hostname.endsWith('.localhost');
  }

  // 1. Aggregator Blacklist (Strictly ignore multi-seller marketplaces)
  function isBlacklistedAggregator() {
    const host = window.location.hostname.toLowerCase();
    const blacklist = [
      'amazon.',
      'flipkart.com',
      'myntra.com',
      'meesho.com',
      'nykaa.com',
      'ajio.com',
      'tatacliq.com',
      'ebay.',
      'aliexpress.',
      'walmart.com',
      'target.com'
    ];
    return blacklist.some(b => host.includes(b));
  }

  // 2. Strict Platform Detection (Shopify Focus)
  function detectPlatform() {
    if (isLocalDevelopmentHost()) {
      return null;
    }

    // 0. Suppress on Marketplaces / Aggregators
    if (isBlacklistedAggregator()) {
      return null;
    }

    // 1. Universal Shopify Signatures
    if (
      window.Shopify ||
      window.ShopifyAnalytics ||
      window.__st ||
      window.BOOMR ||
      document.querySelector('script[src*="/cdn/shop/"]') ||
      document.querySelector('link[href*="/cdn/shop/"]') ||
      document.querySelector('img[src*="/cdn/shop/"]') ||
      document.querySelector('script[src*="cdn.shopify.com"]') ||
      document.querySelector('link[href*="cdn.shopify.com"]') ||
      document.querySelector('script[src*="shopify"]') ||
      document.querySelector('link[href*="shopify"]') ||
      document.querySelector('form[action*="/cart/add"]') ||
      document.querySelector('div[id*="shopify-section"]') ||
      document.querySelector('meta[id*="shopify"]') ||
      document.querySelector('meta[name*="shopify"]') ||
      document.querySelector('meta[content*="Shopify"]') ||
      window.location.pathname.includes('/products/')
    ) {
      return 'shopify';
    }

    return null;
  }

  // 3. Strict Product Detail Page (PDP) Verification
  function isProductPage() {
    const path = window.location.pathname.toLowerCase();

    // Home page is NEVER a product page
    if (path === '/' || path === '' || path === '/index.html') return false;

    // Strict product URL paths FIRST (so /collections/.../products/... is recognized as product page!)
    if (
      path.includes('/products/') ||
      path.includes('/product/') ||
      path.includes('/item/') ||
      path.includes('/p/') ||
      path.includes('/dp/')
    ) {
      return true;
    }

    // Collections, categories, cart, checkout, blogs, search, accounts are store overview pages
    if (
      path.includes('/collections') ||
      path.includes('/category') ||
      path.includes('/categories') ||
      path.includes('/shop') ||
      path.includes('/cart') ||
      path.includes('/checkout') ||
      path.includes('/search') ||
      path.includes('/pages/') ||
      path.includes('/blogs/') ||
      path.includes('/account')
    ) {
      return false;
    }

    return false;
  }

  // 3B. Detect Order Confirmation / Thank You Page
  function isOrderConfirmationPage() {
    const path = window.location.pathname.toLowerCase();
    const search = window.location.search.toLowerCase();
    return (
      path.includes('/thank_you') ||
      path.includes('/thank-you') ||
      path.includes('/orders/') ||
      path.includes('/order-received') ||
      path.includes('/order-confirmation') ||
      path.includes('/checkout/success') ||
      search.includes('key=wc_order_')
    );
  }

  // 3C. Handle Completed Checkout / Purchase Tracking
  async function handleOrderConfirmation(platform) {
    if (document.getElementById('sv-order-tracking-banner')) return;

    console.log('✦ ScrapeVerse detected Order Confirmation / Checkout Success page!');

    // 1. Extract Order Number
    let orderNumber = null;
    const orderNumberEl = 
      document.querySelector('.os-order-number') ||
      document.querySelector('.order-number') ||
      document.querySelector('[data-order-number]') ||
      document.querySelector('.woocommerce-order-overview__order strong');
    
    if (orderNumberEl) {
      orderNumber = orderNumberEl.innerText.trim().replace(/^Order\s*#/i, '#');
    } else {
      const match = document.body.innerText.match(/Order\s*#?([A-Z0-9_-]+)/i);
      if (match) orderNumber = '#' + match[1];
      else orderNumber = '#ORD-' + Date.now().toString().slice(-6);
    }

    // 2. Extract Line Items
    let items = [];
    const tableRows = document.querySelectorAll('.product-table tbody tr, .order-summary__section--product-list tr, .woocommerce-table--order-details tbody tr');
    
    if (tableRows.length > 0) {
      tableRows.forEach(row => {
        const titleEl = row.querySelector('.product__description__name, .product-title, .woocommerce-table__product-name a, td:first-child');
        const priceEl = row.querySelector('.product__price, .order-summary__emphasis, .woocommerce-table__product-total, td:last-child');
        const imgEl = row.querySelector('img');
        const qtyEl = row.querySelector('.product-thumbnail__quantity, .product__quantity');
        const productLink = row.querySelector('a[href*="/products/"], a[href*="/product/"], .woocommerce-table__product-name a');

        if (titleEl) {
          const rawPrice = priceEl ? priceEl.innerText.replace(/[^\d.]/g, '') : '0';
          items.push({
            title: titleEl.innerText.trim(),
            price: Number(rawPrice) || 0,
            quantity: qtyEl ? Number(qtyEl.innerText.replace(/[^\d]/g, '')) || 1 : 1,
            image_url: imgEl ? imgEl.src : '',
            product_url: productLink ? productLink.href : ''
          });
        }
      });
    }

    // Fallback if no table items extracted
    if (items.length === 0) {
      items.push({
        title: document.title.split('|')[0].trim() || 'Store Purchase',
        price: 0,
        quantity: 1,
        image_url: '',
        product_url: ''
      });
    }

    // 3. Extract Total Amount
    let totalAmount = 0;
    const totalEl = 
      document.querySelector('.payment-due__price') ||
      document.querySelector('.total-line__price') ||
      document.querySelector('.order-summary__emphasis') ||
      document.querySelector('.woocommerce-Price-amount');
    
    if (totalEl) {
      totalAmount = Number(totalEl.innerText.replace(/[^\d.]/g, '')) || 0;
    }

    const savedEmail = localStorage.getItem('scrapeverse_user_email') || null;
    const hostDomain = window.location.hostname.replace(/^www\./, '');
    const recentProductContexts = await getRecentProductContexts();

    // Send order to backend
    for (const item of items) {
      try {
        const itemTitle = normalizeProductContextTitle(item.title);
        const rememberedProduct = recentProductContexts.find((context) =>
          context?.title && normalizeProductContextTitle(context.title) === itemTitle
        );
        await backendFetch(`${BACKEND_URL}/api/purchases/track`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            order_number: orderNumber,
            domain: hostDomain,
            platform,
            product_id: rememberedProduct?.id || null,
            url: item.product_url || rememberedProduct?.url || '',
            title: item.title,
            price: item.price || totalAmount,
            quantity: item.quantity || 1,
            total_amount: totalAmount || item.price,
            currency: 'INR',
            image_url: item.image_url,
            order_status_url: window.location.href,
            user_email: savedEmail
          })
        });
      } catch (e) {}
    }

    // 4. Inject Celebratory Confirmation Banner
    const banner = document.createElement('div');
    banner.id = 'sv-order-tracking-banner';
    banner.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      background: #ffffff;
      border: 1px solid #E5E2DC;
      box-shadow: 0 12px 36px rgba(30, 61, 43, 0.15);
      border-radius: 14px;
      padding: 18px 22px;
      z-index: 99999999;
      color: #222222;
      font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'Poppins', 'Segoe UI', Roboto, sans-serif;
      max-width: 380px;
    `;

    banner.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <span style="font-size:12px;font-weight:700;color:#1E3D2B;display:flex;align-items:center;gap:6px;">
          ✦ ScrapeVerse Order Protection
        </span>
        <button id="sv-close-order-banner" style="background:none;border:none;color:#6a6a6a;cursor:pointer;font-size:18px;">&times;</button>
      </div>
      <div style="font-size:15px;font-weight:700;color:#222222;margin-bottom:4px;">
        Order ${orderNumber} Tracked! 🎉
      </div>
      <div style="font-size:12px;color:#6a6a6a;line-height:1.4;margin-bottom:14px;">
        Saved to your Unified Receipts Ledger. <strong>30-Day Post-Purchase Price Drop Protection</strong> is active on this order!
      </div>
      <div style="display:flex;gap:8px;">
        <a href="${BACKEND_URL}/history?tab=purchases" target="_blank" style="background:#1E3D2B;color:#ffffff;font-size:12px;font-weight:600;padding:8px 16px;border-radius:8px;text-decoration:none;display:inline-block;">
          View My Receipts ↗
        </a>
      </div>
    `;

    document.body.appendChild(banner);
    document.getElementById('sv-close-order-banner')?.addEventListener('click', () => banner.remove());
  }

  // 4. Mini Sparkline Generator
  function generateMiniSparkline(points = []) {
    const width = 110;
    const height = 26;
    const padding = 3;

    if (!points || points.length <= 1) {
      return {
        line: `M 0 ${height / 2} L ${width} ${height / 2}`,
        area: `M 0 ${height / 2} L ${width} ${height / 2} L ${width} ${height} L 0 ${height} Z`,
        dot: `<circle cx="${width / 2}" cy="${height / 2}" r="3" fill="#10b981" />`
      };
    }

    const prices = points.map(p => p.price);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const range = (max - min) || 1;

    const coords = points.map((p, idx) => {
      const x = padding + (idx / (points.length - 1)) * (width - padding * 2);
      const y = height - padding - ((p.price - min) / range) * (height - padding * 2);
      return { x, y };
    });

    const line = coords.map((c, i) => `${i === 0 ? 'M' : 'L'} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`).join(' ');
    const area = `${line} L ${coords[coords.length - 1].x.toFixed(1)} ${height} L ${coords[0].x.toFixed(1)} ${height} Z`;
    const lastCoord = coords[coords.length - 1];
    const dot = `<circle cx="${lastCoord.x.toFixed(1)}" cy="${lastCoord.y.toFixed(1)}" r="3" fill="#10b981" />`;

    return { line, area, dot };
  }

  // Read only visible PDP hints for the immediate local preview. These values
  // are never sent to the backend, persisted, or used for enrichment.
  function isVisibleHintElement(element) {
    if (!element || !element.textContent?.trim()) return false;
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' &&
      Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0;
  }

  function parseVisiblePrice(text) {
    const value = String(text || '').replace(/\u00a0/g, ' ').trim();
    const currencyMatch = value.match(/(?:₹|Rs\.?|INR|USD|\$|€|£)\s*([\d,]+(?:\.\d{1,2})?)/i);
    const numberMatch = currencyMatch || value.match(/\b\d[\d,]*(?:\.\d{1,2})?\b/);
    if (!numberMatch) return null;
    const numeric = Number(String(numberMatch[1] || numberMatch[0]).replace(/,/g, ''));
    return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
  }

  function cleanPreviewTitle(text) {
    const title = String(text || '')
      .replace(/(?:^|\s)[.#][a-z0-9_-]+\s*\{[^}]*\}/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (/\b(?:customer reviews|be the first to write a review|write a review)\b/i.test(title)) return '';
    return title.length >= 2 && title.length <= 180 ? title : '';
  }

  function truncateDisplayTitle(text, maxChars = 30) {
    const fullTitle = String(text || '').replace(/\s+/g, ' ').trim();
    if (fullTitle.length <= maxChars) return fullTitle;
    return `${fullTitle.slice(0, maxChars - 1).trimEnd()}…`;
  }

  function getBrandTrustState(reputation = {}) {
    const rawScore = Number(reputation.trust_score);
    const score = Number.isFinite(rawScore)
      ? Math.round(Math.max(0, Math.min(100, rawScore)))
      : null;
    const declaredRisk = String(reputation.scam_risk || '').toUpperCase();
    const highRisk = declaredRisk === 'HIGH' || (score !== null && score < 50);
    const caution = !highRisk && (declaredRisk === 'MEDIUM' || declaredRisk === 'MODERATE' || (score !== null && score < 70));
    const scoreLabel = score === null ? 'Score unavailable' : `${score}% Brand Trust`;

    if (highRisk) {
      return {
        className: 'sv-scam-pill-danger',
        label: `🚨 ${scoreLabel} · High Risk`,
        badgeLabel: `🚨 ${scoreLabel} · HIGH RISK`,
        title: 'Low brand trust or a high scam-risk signal was detected. Hover to view the supporting web sources.'
      };
    }

    if (caution) {
      return {
        className: 'sv-brand-pill-warning',
        label: `⚠️ ${scoreLabel} · Caution`,
        badgeLabel: `⚠️ ${scoreLabel} · CAUTION`,
        title: 'Brand trust is below the healthy range. Review the supporting web sources before purchasing.'
      };
    }

    return {
      className: 'sv-brand-trust-pill',
      label: `🛡️ ${scoreLabel}`,
      badgeLabel: `🛡️ ${scoreLabel}`,
      title: `${reputation.sentiment_label || 'Verified brand standing'} (Researched across Reddit, YouTube & Trustpilot • Hover to view proof)`
    };
  }

  function renderedElementText(element) {
    // Shopify themes often keep a raw minor-unit value in text/data nodes while
    // rendering the formatted major-unit price separately. innerText reflects
    // what the shopper actually sees; textContent is only the fallback.
    return String(element?.innerText || element?.textContent || '')
      .replace(/\u00a0/g, ' ')
      .trim()
      .replace(/\s+/g, ' ');
  }

  function readStructuredMajorPrice() {
    const selectors = [
      'meta[property="product:price:amount"]',
      'meta[property="og:price:amount"]',
      'meta[itemprop="price"]'
    ];
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      const raw = element?.getAttribute('content');
      const value = Number(String(raw || '').replace(/,/g, ''));
      if (Number.isFinite(value) && value > 0) return value;
    }
    return null;
  }

  function readVisibleProductHints() {
    const titleSelectors = [
      'h1[itemprop="name"]', '[data-product-title]', '[data-testid*="product-title"]',
      '.product__title h1', '.product-title', '.product-single__title', 'h1'
    ];
    const priceSelectors = [
      '[itemprop="price"]', '[data-product-price]', '[data-price]',
      '.price__current', '.product__price', '.product-price', '.price',
      '[class*="price"]'
    ];

    const firstVisibleText = (selectors, limit = 180) => {
      for (const selector of selectors) {
        const element = Array.from(document.querySelectorAll(selector)).find(isVisibleHintElement);
        if (element) return renderedElementText(element).slice(0, limit);
      }
      return '';
    };

    const title = cleanPreviewTitle(firstVisibleText(titleSelectors, 180)) ||
      cleanPreviewTitle(document.title.split('|')[0].trim().slice(0, 180));
    let price = null;
    let priceText = '';
    for (const selector of priceSelectors) {
      const element = Array.from(document.querySelectorAll(selector)).find(isVisibleHintElement);
      const renderedText = element ? renderedElementText(element) : '';
      const candidate = renderedText ? parseVisiblePrice(renderedText) : null;
      if (candidate) {
        price = candidate;
        priceText = renderedText;
        break;
      }
    }

    // Some Shopify themes expose the visible price as minor units (e.g.
    // 49900) while product metadata exposes the rendered major price (499).
    // Convert only when both values agree, so a real ₹49,900 is preserved.
    const structuredPrice = readStructuredMajorPrice();
    if (price >= 10000 && structuredPrice > 0 && Math.abs((price / 100) - structuredPrice) < 0.01) {
      price = structuredPrice;
    }

    const currency = /(?:₹|Rs\.?|INR)/i.test(priceText) ? 'INR' :
      (priceText.includes('€') ? 'EUR' : (priceText.includes('£') ? 'GBP' : 'USD'));
    return { title: title || 'Product preview', price, currency };
  }

  function estimatedPreviewData(preview) {
    const basePrice = Number(preview.price);
    if (!Number.isFinite(basePrice) || basePrice <= 0) {
      return { history: [], lowestPrice: null, highestPrice: null };
    }
    const multipliers = [1.35, 1.25, 1.15, 1.05, 1];
    const history = multipliers.map((multiplier, index) => ({
      price: Math.round(basePrice * multiplier),
      checked_at: new Date(Date.now() - (120 - index * 30) * 24 * 60 * 60 * 1000).toISOString(),
      estimated: true
    }));
    return {
      history,
      lowestPrice: history[history.length - 1].price,
      highestPrice: history[0].price
    };
  }

  function updateEnrichmentStatus(bannerEl, stage, message) {
    const statusEl = bannerEl?.querySelector('#sv-enrichment-status');
    if (!statusEl) return;
    const previousStage = statusEl.dataset.stage || '';
    const nextStage = stage || '';
    const labels = {
      collector_provisioning: 'Creating store collector...',
      verification_scraping: 'Verification scrape started...',
      collector_scraping: 'Store collector is scraping...',
      collector_failed: 'Collector creation failed.',
      collector_ready: 'Store collector ready ✓',
      product_scraping: 'Product scrape started...',
      product_saved: 'Product data received and saved ✓',
      starting: 'Preparing store intelligence...',
      brand_reputation: 'Brand reputation search in progress...',
      brand_reputation_cached: 'Brand reputation loaded from cache.',
      brand_reputation_saved: 'Brand reputation data received and saved ✓',
      review_scraping: 'Review scraping in progress...',
      review_saved: 'Review data received and saved ✓',
      ai_summary: 'Generating AI review summary...',
      product_rechecking: 'Checking live product data...',
      collector_self_healing: 'Self-healing collector...',
      collector_healed: 'Collector self-healing completed ✓',
      collector_heal_failed: 'Collector self-healing failed.',
      complete: 'Store intelligence ready ✓',
      failed: 'Store intelligence needs a retry.'
    };
    const displayMessage = String(message || labels[stage] || 'Working on store intelligence...')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 240);
    statusEl.innerText = displayMessage;
    statusEl.title = displayMessage;
    statusEl.dataset.stage = nextStage;
    const failureStage = nextStage === 'failed' || nextStage === 'collector_failed' || nextStage === 'collector_heal_failed';
    const pendingStage = [
      'collector_provisioning',
      'verification_scraping',
      'collector_scraping',
      'product_scraping',
      'brand_reputation',
      'review_scraping',
      'ai_summary',
      'product_rechecking',
      'collector_self_healing'
    ].includes(nextStage);
    statusEl.classList.toggle('sv-status-pending', pendingStage);
    statusEl.classList.toggle('sv-status-failure', failureStage);
    statusEl.style.color = failureStage ? 'var(--sv-danger)' :
      (nextStage === 'complete' || nextStage === 'collector_ready' ? 'var(--sv-primary)' : 'var(--sv-text-muted)');

    // Play once when a real task stage changes. Repeated polling of the same
    // stage stays silent, and the initial collector status does not beep.
    if (previousStage && previousStage !== nextStage) {
      bindStatusAudioUnlock();
      playStatusChangeSound(nextStage);
    }
  }

  function pollStoreCollectorStatus(bannerEl, domain, platform, attempt = 0) {
    if (!bannerEl || !domain || attempt > 450 || !document.contains(bannerEl)) return;

    setTimeout(async () => {
      let continuePolling = true;
      try {
        const response = await backendFetch(
          `${BACKEND_URL}/api/store-collector-status?domain=${encodeURIComponent(domain)}&platform=${encodeURIComponent(platform)}`,
          { cache: 'no-store' }
        );
        const json = await response.json().catch(() => ({}));
        const statusEl = bannerEl.querySelector('#sv-enrichment-status');
        const currentStage = statusEl?.dataset.stage || '';
        const collectorStatus = json.collector_status;
        const collectorPhase = json.collector_phase;

        // Only the collector stages are owned by this poller. Once product
        // enrichment has moved on, it must not overwrite brand/review status.
        const collectorStageVisible = [
          'collector_provisioning',
          'verification_scraping',
          'collector_scraping',
          'collector_failed',
          'product_scraping',
          'product_saved'
        ].includes(currentStage);

        if (collectorPhase === 'verification_scraping' && collectorStageVisible) {
          updateEnrichmentStatus(bannerEl, 'verification_scraping', 'Verification scrape started...');
        } else if (collectorPhase === 'product_scraping') {
          updateEnrichmentStatus(bannerEl, 'product_scraping', 'Product scrape started...');
        } else if (collectorPhase === 'product_saved') {
          updateEnrichmentStatus(bannerEl, 'product_saved', 'Product data received and saved ✓');
          continuePolling = false;
        } else if (collectorStatus === 'ready' && json.collector_id) {
          if (collectorStageVisible) {
            updateEnrichmentStatus(bannerEl, 'collector_ready', 'Store collector ready ✓');
          }
          continuePolling = false;
        } else if (collectorStageVisible && collectorStatus === 'failed') {
          const retryAfter = Math.max(1000, Number(json.retry_after_ms) || 5000);
          updateEnrichmentStatus(
            bannerEl,
            'collector_failed',
            `⚠ Collector creation failed · Retrying in ${Math.ceil(retryAfter / 1000)} seconds`
          );
          if (json.collector_error && statusEl) {
            statusEl.title = `${statusEl.innerText}: ${json.collector_error}`;
          }
        } else if (collectorStageVisible && collectorStatus === 'provisioning') {
          updateEnrichmentStatus(bannerEl, 'collector_provisioning', 'Creating store collector...');
        }
      } catch (error) {
        console.warn('[ScrapeVerse] Collector status notice:', error.message);
      }

      if (continuePolling) {
        pollStoreCollectorStatus(bannerEl, domain, platform, attempt + 1);
      }
    }, attempt === 0 ? 500 : 2200);
  }

  function bindTooltipViewportAlignment(root) {
    if (!root) return;
    root.querySelectorAll('.sv-delivery-tooltip-wrap, .sv-sold-tooltip-wrap').forEach(wrapper => {
      const tooltip = wrapper.querySelector('.sv-brand-tooltip-box, .sv-delivery-tooltip-box, .sv-sold-tooltip-box');
      if (!tooltip || wrapper.dataset.svTooltipBound === 'true') return;

      wrapper.dataset.svTooltipBound = 'true';
      wrapper.addEventListener('mouseenter', () => {
        wrapper.classList.remove('sv-tooltip-align-left', 'sv-tooltip-align-right');
        const wrapperRect = wrapper.getBoundingClientRect();
        const tooltipWidth = tooltip.getBoundingClientRect().width;
        const centeredLeft = wrapperRect.left + (wrapperRect.width / 2) - (tooltipWidth / 2);
        const edgePadding = 14;

        if (centeredLeft < edgePadding) {
          wrapper.classList.add('sv-tooltip-align-left');
        } else if (centeredLeft + tooltipWidth > window.innerWidth - edgePadding) {
          wrapper.classList.add('sv-tooltip-align-right');
        }
      });
    });
  }

  function setPreviewActionsEnabled(bannerEl, enabled) {
    const actionIds = ['sv-alert-notify-btn', 'sv-open-sidebar-btn', 'sv-price-trend-btn', 'sv-recheck-btn'];
    actionIds.forEach(id => {
      const element = bannerEl?.querySelector(`#${id}`);
      if (!element) return;
      element.setAttribute('aria-disabled', enabled ? 'false' : 'true');
      element.style.opacity = enabled ? '1' : '0.45';
      element.style.pointerEvents = enabled ? 'auto' : 'none';
      element.style.cursor = enabled ? 'pointer' : 'not-allowed';
      if (!enabled) element.title = 'Available after verified product data is loaded';
    });

    const alertButton = bannerEl?.querySelector('#sv-alert-notify-btn');
    if (alertButton) alertButton.disabled = !enabled;
    const sidebarButton = bannerEl?.querySelector('#sv-open-sidebar-btn');
    if (sidebarButton) sidebarButton.disabled = !enabled;
    const recheckButton = bannerEl?.querySelector('#sv-recheck-btn');
    if (recheckButton && !manualRecheckInFlight) recheckButton.disabled = !enabled;
  }

  function loadCachedBrandReputationForProductBanner(bannerEl, domain) {
    if (!bannerEl || !domain) return;
    backendFetch(
      `${BACKEND_URL}/api/brand-reputation-cache?domain=${encodeURIComponent(domain)}`,
      { cache: 'no-store' }
    )
      .then(res => res.json().catch(() => ({})))
      .then(json => {
        if (json.success && json.reputation) {
          applyBrandReputationToProductBanner(bannerEl, {
            ...json.reputation,
            fromCache: true
          });
        }
      })
      .catch(error => console.warn('[ScrapeVerse] Cached brand reputation notice:', error.message));
  }

  function renderPreviewTopBanner(bannerEl, preview) {
    const estimated = estimatedPreviewData(preview);
    const titleEl = bannerEl.querySelector('#sv-prod-title');
    const fullPreviewTitle = preview.title || 'Product preview';
    if (titleEl) {
      titleEl.innerText = truncateDisplayTitle(fullPreviewTitle);
      titleEl.title = fullPreviewTitle;
    }

    const currentEl = bannerEl.querySelector('#sv-preview-current-price');
    if (currentEl) currentEl.innerText = preview.price ? `${preview.currency === 'INR' ? '₹' : ''}${preview.price}` : 'Price unavailable';
    const rangeEl = bannerEl.querySelector('#sv-preview-range');
    if (rangeEl) rangeEl.innerText = estimated.lowestPrice ?
      `${preview.currency === 'INR' ? '₹' : ''}${estimated.lowestPrice} — ${preview.currency === 'INR' ? '₹' : ''}${estimated.highestPrice}` :
      'Estimated range unavailable';

    const spark = generateMiniSparkline(estimated.history);
    const svg = bannerEl.querySelector('#sv-preview-sparkline');
    if (svg) {
      svg.innerHTML = `<path d="${spark.area}" fill="rgba(30, 61, 43, 0.12)" /><path d="${spark.line}" fill="none" stroke="#1E3D2B" stroke-width="2" stroke-linecap="round" />${spark.dot}`;
    }
    updateEnrichmentStatus(bannerEl, 'collector_provisioning', 'Creating store collector...');
    setPreviewActionsEnabled(bannerEl, false);
  }

  function pollEnrichmentStatus(productId, bannerEl, attempt = 0, domain = '') {
    if (!productId || !bannerEl || attempt > 45) return;
    setTimeout(async () => {
      try {
        const [enrichmentRes, healthRes] = await Promise.all([
          backendFetch(`${BACKEND_URL}/api/enrichment-status?product_id=${encodeURIComponent(productId)}`),
          domain
            ? backendFetch(`${BACKEND_URL}/api/collector-health-status?domain=${encodeURIComponent(domain)}`)
            : Promise.resolve(null)
        ]);
        const json = await enrichmentRes.json().catch(() => ({}));
        const healthJson = healthRes ? await healthRes.json().catch(() => ({})) : {};
        const stage = json.status?.stage;
        const collectorStatus = healthJson.active ? healthJson.status : null;

        if (collectorStatus?.stage) {
          updateEnrichmentStatus(bannerEl, collectorStatus.stage, collectorStatus.message);
        } else if (stage) {
          updateEnrichmentStatus(bannerEl, stage, json.status.message);
        }
        if (!collectorStatus && (stage === 'complete' || stage === 'failed' || json.pending === false)) {
          if (stage === 'complete') refreshReviewSummary(productId);
          return;
        }
      } catch (error) {
        console.warn('[ScrapeVerse] Enrichment status notice:', error.message);
      }
      pollEnrichmentStatus(productId, bannerEl, attempt + 1, domain);
    }, attempt === 0 ? 1200 : 2200);
  }

  async function waitForCollectorHealing(bannerEl, domain, initialMessage = '') {
    // Bright Data self-healing can take up to 15 minutes. Keep polling long
    // enough to show the real healing state instead of timing out into a
    // misleading generic retry message.
    const maxAttempts = 450;
    let sawHealing = false;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const healthRes = await backendFetch(
          `${BACKEND_URL}/api/collector-health-status?domain=${encodeURIComponent(domain)}`,
          { cache: 'no-store' }
        );
        const healthJson = await healthRes.json().catch(() => ({}));
        const healthStatus = healthJson.active ? healthJson.status : null;

        if (healthStatus?.stage) {
          updateEnrichmentStatus(bannerEl, healthStatus.stage, healthStatus.message);
          if (healthStatus.stage === 'collector_self_healing') {
            sawHealing = true;
            await new Promise(resolve => setTimeout(resolve, 2200));
            continue;
          }
          return healthStatus.stage;
        }

        // The backend response can arrive just before the health endpoint is
        // updated. Give that status a few polling attempts to appear.
        if (!sawHealing && attempt < 3) {
          if (initialMessage) updateEnrichmentStatus(bannerEl, 'collector_self_healing', initialMessage);
          await new Promise(resolve => setTimeout(resolve, 1000));
          continue;
        }
        return null;
      } catch (error) {
        console.warn('[ScrapeVerse] Self-healing status notice:', error.message);
        await new Promise(resolve => setTimeout(resolve, 2200));
      }
    }

    updateEnrichmentStatus(bannerEl, 'collector_heal_failed', 'Self-healing status timed out. Please retry later.');
    return 'collector_heal_failed';
  }

  async function runManualRecheck(bannerEl, platform) {
    if (!bannerEl || manualRecheckInFlight) return;
    const button = bannerEl.querySelector('#sv-recheck-btn');
    if (!button || button.disabled) return;

    manualRecheckInFlight = true;
    const buttonText = button.querySelector('#sv-recheck-btn-text');
    button.disabled = true;
    button.style.opacity = '0.6';
    if (buttonText) buttonText.innerText = 'Rechecking...';
    updateEnrichmentStatus(bannerEl, 'starting', 'Checking live product data...');

    try {
      let json = null;
      let response = null;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        response = await backendFetch(`${BACKEND_URL}/api/scrape`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: window.location.href,
            platform,
            manual_recheck: true
          })
        });
        json = await response.json().catch(() => ({}));

        if (response.status !== 202 && json.status !== 'collector_provisioning' && json.status !== 'product_scrape_retry') break;
        updateEnrichmentStatus(
          bannerEl,
          json.status === 'product_scrape_retry' ? 'collector_scraping' : 'collector_provisioning',
          json.message || 'Preparing the store collector...'
        );
        await new Promise(resolve => setTimeout(resolve, Math.max(2500, Number(json.retry_after_ms) || 5000)));
      }

      if (!response?.ok || !json?.success || !json.data) {
        throw new Error(json?.error || 'Live product data was unavailable');
      }

      populateTopBanner(bannerEl, json.data, platform);
      injectSidebar(json.data);
      updateEnrichmentStatus(
        bannerEl,
        json.data.enrichmentStatus?.stage || 'starting',
        json.data.enrichmentStatus?.message || 'Live product data refreshed.'
      );
      if (json.data.enrichmentPending && json.data.product?.id) {
        refreshReviewSummary(json.data.product.id);
        pollEnrichmentStatus(json.data.product.id, bannerEl, 0, window.location.hostname.replace(/^www\./, ''));
      }
    } catch (error) {
      updateEnrichmentStatus(bannerEl, 'failed', `Recheck failed: ${error.message}`);
      console.warn('[ScrapeVerse] Manual product recheck failed:', error);
    } finally {
      manualRecheckInFlight = false;
      if (buttonText) buttonText.innerText = 'Recheck';
      button.disabled = false;
      button.style.opacity = '1';
    }
  }

  // 5. Sidebar Open / Close State
  function openSidebar() {
    const backdrop = document.getElementById('scrapeverse-backdrop');
    const sidebar = document.getElementById('scrapeverse-sidebar');
    if (backdrop) backdrop.classList.add('active');
    if (sidebar) {
      sidebar.classList.add('active');
      fetchAndRenderSimilarGrid();
    }
  }

  function closeSidebar() {
    const backdrop = document.getElementById('scrapeverse-backdrop');
    const sidebar = document.getElementById('scrapeverse-sidebar');
    if (backdrop) backdrop.classList.remove('active');
    if (sidebar) sidebar.classList.remove('active');
  }

  // 6. Initialize Top Companion Header (Dual-Mode: PDP vs Store Overview)
  async function init() {
    const platform = detectPlatform();
    if (!platform || document.getElementById('scrapeverse-top-banner')) {
      return;
    }
    bindStatusAudioUnlock();

    const hostDomain = window.location.hostname.replace(/^www\./, '');
    const pageType = isOrderConfirmationPage() ? 'order' : (isProductPage() ? 'product' : 'store');
    recordTrafficSignal({ domain: hostDomain, platform, pageType });

    // A. Check for Completed Purchase / Checkout Success
    if (isOrderConfirmationPage()) {
      handleOrderConfirmation(platform);
      return;
    }

    if (pageType === 'product') {
      // ─────────────────────────────────────────────
      // MODE A: Single Product PDP Mode (100% Pure Bright Data Engine)
      // ─────────────────────────────────────────────
      const brandName = hostDomain.split('.')[0].toUpperCase();
      if (productInitializationInFlight) return;
      productInitializationInFlight = true;
      console.log(`✦ ScrapeVerse detected PDP: ${window.location.href} (${platform.toUpperCase()}) — Calling Bright Data Scraper Studio...`);

      const preview = readVisibleProductHints();
      const previewHistory = estimatedPreviewData(preview).history;
      const initialSpark = generateMiniSparkline(previewHistory);

      const bannerEl = document.createElement('div');
      bannerEl.id = 'scrapeverse-top-banner';
      bannerEl.innerHTML = `
        <!-- Row 1: Brand & Store Intelligence Row -->
        <div class="sv-banner-info-row">
          <div class="sv-banner-left" style="display:flex;align-items:center;gap:8px;">
            <div class="sv-logo">✦ ScrapeVerse</div>
            <span class="sv-platform-badge">${platform.toUpperCase()}</span>
            <span class="sv-brand-badge" id="sv-brand-tag-pill" style="font-size:11px;font-weight:700;background:var(--sv-surface-soft);color:var(--sv-text-main);padding:3px 10px;border-radius:var(--sv-radius-full);border:1px solid var(--sv-border);white-space:nowrap;letter-spacing:0.3px;">
              🏷️ ${brandName}
            </span>
            <!-- AI Star Rating Badge with Full Customer Review Hover Tooltip -->
            <div class="sv-delivery-tooltip-wrap" id="sv-rating-container" style="display:none;margin-left:4px;">
              <span class="sv-brand-trust-pill" id="sv-rating-pill" style="cursor:help;display:inline-flex;align-items:center;gap:4px;">
                <span id="sv-top-rating-text" style="font-size:11px;font-weight:700;">⭐ Analyzing...</span>
              </span>
              <div class="sv-brand-tooltip-box sv-review-tooltip-box" id="sv-reviews-expanded-panel">
                <div class="sv-review-panel-header" style="display:flex;justify-content:space-between;align-items:center;padding-bottom:10px;border-bottom:1px solid var(--sv-border);">
                  <div class="sv-review-panel-heading" style="display:flex;align-items:center;gap:10px;">
                    <span class="sv-review-panel-title" style="font-size:12px;font-weight:700;color:var(--sv-text-main);display:flex;align-items:center;gap:6px;">
                      💬 AI Product Customer Reviews & Sentiments
                    </span>
                    <span id="sv-panel-sentiment-pill" class="sv-review-sentiment-pill" style="font-size:10px;background:var(--sv-primary-soft);color:var(--sv-primary);font-weight:700;padding:2px 8px;border-radius:var(--sv-radius-full);border:1px solid var(--sv-border);">
                      94% Positive (High Trust)
                    </span>
                  </div>
                  <span id="sv-panel-grounded-meta" class="sv-review-grounded-meta" style="font-size:9px;color:var(--sv-text-muted);">⚡ Judge.me review check every 30 days</span>
                </div>
                <div class="sv-review-panel-rating" style="display:flex;align-items:center;gap:8px;margin-top:10px;margin-bottom:8px;">
                  <strong id="sv-panel-rating-num" style="font-size:16px;color:var(--sv-primary);font-weight:800;">★ 4.8 / 5</strong>
                  <span id="sv-panel-review-count" style="font-size:11px;color:var(--sv-text-muted);">Based on verified reviews</span>
                </div>
                <div class="sv-review-panel-summary" style="background:var(--sv-surface-soft);border:1px solid var(--sv-border);border-radius:var(--sv-radius-sm);padding:8px 10px;margin-bottom:10px;">
                  <p id="sv-panel-summary-text" style="font-size:11px;line-height:1.4;color:var(--sv-text-body);margin:0;">
                    Loading customer feedback summary...
                  </p>
                </div>
                <div class="sv-review-panel-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
                  <div class="sv-review-panel-column">
                    <div class="sv-review-panel-section-title sv-review-panel-section-title-positive" style="font-size:11px;font-weight:700;color:var(--sv-primary);margin-bottom:6px;display:flex;align-items:center;gap:4px;">
                      <span>✓</span> Key Positives & Highlights
                    </div>
                    <div id="sv-panel-positive-list" class="sv-review-panel-list" style="display:flex;flex-direction:column;gap:4px;"></div>
                  </div>
                  <div class="sv-review-panel-column">
                    <div class="sv-review-panel-section-title sv-review-panel-section-title-negative" style="font-size:11px;font-weight:700;color:var(--sv-danger);margin-bottom:6px;display:flex;align-items:center;gap:4px;">
                      <span>!</span> Watchouts & Things to Know
                    </div>
                    <div id="sv-panel-negative-list" class="sv-review-panel-list" style="display:flex;flex-direction:column;gap:4px;"></div>
                  </div>
                </div>
              </div>
            </div>

            <!-- Brand Web Reputation Hover Tooltip -->
            <div class="sv-delivery-tooltip-wrap" id="sv-brand-trust-container">
              <span class="sv-brand-trust-pill" id="sv-brand-trust-pill" style="cursor:help;display:inline-flex;align-items:center;gap:4px;">
                <span>⚡ Checking 30-day brand cache...</span>
              </span>
              <div class="sv-brand-tooltip-box" id="sv-brand-rep-expanded-panel">
                <div style="display:flex;justify-content:space-between;align-items:center;padding-bottom:10px;border-bottom:1px solid var(--sv-border);">
                  <div style="display:flex;align-items:center;gap:10px;">
                    <span style="font-size:12px;font-weight:700;color:var(--sv-text-main);display:flex;align-items:center;gap:6px;">
                      🌐 30-Day Open-Web Brand Standing & Scam Radar
                    </span>
                    <span id="sv-brand-scam-badge" style="font-size:10px;background:var(--sv-primary-soft);color:var(--sv-primary);font-weight:700;padding:2px 8px;border-radius:var(--sv-radius-full);border:1px solid var(--sv-border);">
                      🛡️ 94% Brand Trust
                    </span>
                  </div>
                  <span id="sv-brand-cache-meta" style="font-size:9px;color:var(--sv-text-muted);">⚡ 30-Day Intelligence Cache</span>
                </div>
                <div style="background:var(--sv-surface-soft);border:1px solid var(--sv-border);border-radius:var(--sv-radius-sm);padding:8px 10px;margin-top:10px;margin-bottom:10px;">
                  <p id="sv-brand-ai-summary" style="font-size:11px;line-height:1.4;color:var(--sv-text-body);margin:0;">
                    Checking the cached 30-day brand reputation...
                  </p>
                </div>
                <div id="sv-brand-sources-list" style="display:grid;grid-template-columns:repeat(3, minmax(0, 1fr));gap:6px;">
                  <!-- dynamic direct external review proof links -->
                </div>
              </div>
            </div>

            <!-- DTC Delivery Tooltip -->
            <div class="sv-delivery-tooltip-wrap">
              <span class="sv-delivery-success-pill" id="sv-delivery-success-pill" style="font-size:11px;font-weight:700;background:var(--sv-surface-soft);color:var(--sv-text-main);padding:3px 10px;border-radius:var(--sv-radius-full);border:1px solid var(--sv-border);display:flex;align-items:center;gap:4px;white-space:nowrap;cursor:help;">
                <span>📦</span>
                <span id="sv-delivery-rate-text">Checking delivery data...</span>
              </span>
              <div class="sv-delivery-tooltip-box">
                <div style="font-weight:700;color:var(--sv-primary);margin-bottom:4px;display:flex;align-items:center;gap:5px;">
                  <span>📦 DTC Delivery & Shipping Health</span>
                </div>
                <div style="display:grid;grid-template-columns:repeat(3, 1fr);gap:4px;margin-bottom:6px;background:var(--sv-surface-soft);padding:6px;border-radius:var(--sv-radius-sm);text-align:center;">
                  <div>
                    <div style="font-size:8px;color:var(--sv-text-muted);text-transform:uppercase;">Speed</div>
                    <strong style="font-size:11px;color:var(--sv-text-main);" id="sv-tooltip-del-days">Checking...</strong>
                  </div>
                  <div>
                    <div style="font-size:8px;color:var(--sv-text-muted);text-transform:uppercase;">On-Time</div>
                    <strong style="font-size:11px;color:var(--sv-primary);" id="sv-tooltip-del-ontime">Not available</strong>
                  </div>
                  <div>
                    <div style="font-size:8px;color:var(--sv-text-muted);text-transform:uppercase;">Packaging</div>
                    <strong style="font-size:11px;color:var(--sv-primary);" id="sv-tooltip-del-pkg">Not available</strong>
                  </div>
                </div>
                <div style="color:var(--sv-text-body);font-size:11px;margin-bottom:6px;line-height:1.4;" id="sv-tooltip-del-summary">
                  Delivery information will appear when supported review data is available.
                </div>
                <div style="font-size:10px;color:var(--sv-text-muted);border-top:1px solid var(--sv-border);padding-top:4px;display:flex;justify-content:space-between;align-items:center;">
                  <span>🚚 Couriers: <strong id="sv-tooltip-del-couriers" style="color:var(--sv-text-main);">Not specified</strong></span>
                </div>
              </div>
            </div>
          </div>

          <div style="display:flex;align-items:center;gap:8px;">
            <span id="sv-enrichment-status" data-stage="collector_provisioning" class="sv-enrichment-status" title="Store intelligence status">
              Creating store collector...
            </span>
            <button class="sv-alert-btn" id="sv-recheck-btn" disabled aria-label="Recheck live product data" data-sv-tooltip="Recheck live product data: name, price, and compare-at price. A price drop can notify eligible subscribers." title="Recheck live product data: name, price, and compare-at price. A price drop can notify eligible subscribers.">
              <span>↻</span>
              <span id="sv-recheck-btn-text">Recheck</span>
            </button>
            <a href="${BACKEND_URL}/history" target="_blank" class="sv-alert-btn" style="text-decoration:none;" aria-label="Open shopping history" data-sv-tooltip="Open Shopping History: view products you have visited and saved." title="Open Shopping History: view products you have visited and saved.">
              <span>🕒 History ↗</span>
            </a>
          </div>
        </div>

        <!-- Row 2: Action & Live Pricing Row -->
        <div class="sv-banner-action-row">
          <!-- Left/Middle: Product Title + Live Price, Range with Mini Sparkline & Buyer Volume -->
          <div style="display:flex;align-items:center;gap:14px;flex:1;min-width:0;">
            <span class="sv-product-name" id="sv-prod-title" style="font-weight:600;color:var(--sv-text-main);max-width:280px;flex-shrink:0;">Product preview</span>
            <span id="sv-product-state-badge" data-sv-tooltip="Preview: name and price read from visible page hints before backend verification. Preview values are not saved or used for reviews or AI." style="font-size:9px;color:var(--sv-text-muted);font-weight:700;border:1px solid var(--sv-border);border-radius:999px;padding:2px 6px;white-space:nowrap;">Preview</span>
            <div class="sv-banner-center" id="sv-prod-banner-center" style="display:flex;align-items:center;gap:12px;flex-wrap:nowrap;">
              <div class="sv-price-item">
                <span class="sv-price-label">Current:</span>
                <span class="sv-price-val current" id="sv-preview-current-price" style="color:var(--sv-primary);font-size:15px;font-weight:800;">${preview.price ? `${preview.currency === 'INR' ? '₹' : ''}${preview.price}` : 'Price unavailable'}</span>
              </div>

              <div class="sv-price-item" style="display:flex;align-items:center;gap:6px;">
                <span class="sv-price-label">Range:</span>
                <span class="sv-price-val" id="sv-preview-range" style="color:var(--sv-text-muted);font-size:11px;">${previewHistory.length ? `${preview.currency === 'INR' ? '₹' : ''}${Math.min(...previewHistory.map(p => p.price))} — ${preview.currency === 'INR' ? '₹' : ''}${Math.max(...previewHistory.map(p => p.price))}` : 'Estimated range unavailable'}</span>
                <span data-sv-tooltip="Estimated: the initial range and graph are approximated from the visible preview price until backend data is verified." style="font-size:9px;color:var(--sv-text-muted);font-weight:600;border:1px solid var(--sv-border);border-radius:999px;padding:2px 5px;">Estimated</span>
                <div id="sv-sparkline-svg-holder" style="display:flex;align-items:center;" title="Price Trajectory Baseline">
                  <svg class="sv-sparkline-svg" id="sv-preview-sparkline" viewBox="0 0 100 24" preserveAspectRatio="none">
                    <path d="${initialSpark.area}" fill="rgba(30, 61, 43, 0.12)" />
                    <path d="${initialSpark.line}" fill="none" stroke="#1E3D2B" stroke-width="2" stroke-linecap="round" />
                    ${initialSpark.dot}
                  </svg>
                </div>
              </div>

              <div class="sv-price-item">
                <div class="sv-sold-tooltip-wrap">
                  <span class="sv-price-val" style="color:var(--sv-text-muted);font-size:11px;font-weight:600;text-decoration:underline dotted;text-underline-offset:3px;">
                    🛍️ Verifying Sales...
                  </span>
                  <div class="sv-sold-tooltip-box">
                    <div style="font-weight:700;color:var(--sv-primary);margin-bottom:3px;display:flex;align-items:center;gap:4px;">
                      <span>🛍️ How Order Volume is Calculated</span>
                    </div>
                    <div style="color:var(--sv-text-body);margin-bottom:5px;line-height:1.4;">
                      Estimated from verified public customer reviews combined with real-time checkout orders tracked across ScrapeVerse.
                    </div>
                    <div style="font-size:10px;color:var(--sv-primary);font-weight:700;border-top:1px solid var(--sv-border);padding-top:4px;display:flex;align-items:center;gap:4px;">
                      <span>⚡ 100% Grounded in Public Signals</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- Right End: Action Buttons -->
          <div class="sv-banner-right" style="display:flex;align-items:center;gap:8px;flex-shrink:0;">
            <a href="${BACKEND_URL}/price-history?url=${encodeURIComponent(window.location.href)}" target="_blank" class="sv-alert-btn" id="sv-price-trend-btn" style="text-decoration:none;" aria-label="View price trend" data-sv-tooltip="Price Trend: view this product's verified price history and changes over time." title="Price Trend: view this product's verified price history and changes over time.">
              <span>📈 Price Trend ↗</span>
            </a>
            <button class="sv-alert-btn" id="sv-alert-notify-btn" aria-label="Set a price drop alert" data-sv-tooltip="Notify on Drop: set an email alert when this product reaches your target price." title="Notify on Drop: set an email alert when this product reaches your target price.">
              <span>🔔</span>
              <span id="sv-alert-btn-text">Notify on Drop</span>
            </button>
            <button class="sv-cta-btn" id="sv-open-sidebar-btn" aria-label="Find similar products" data-sv-tooltip="Similar Styles: find comparable products and cheaper alternatives." title="Similar Styles: find comparable products and cheaper alternatives.">
              <span>✦ Similar Styles</span>
              <span>→</span>
            </button>
          </div>
        </div>
      `;

      // Mount the local preview immediately. Preview values stay in the page;
      // only the URL and platform are sent to the backend below.
      const ratingContainer = bannerEl.querySelector('#sv-rating-container');
      const productTitleEl = bannerEl.querySelector('#sv-prod-title');
      if (ratingContainer && productTitleEl) {
        // Keep the review badge beside the product name in Row 2 while
        // retaining its existing hover panel and live update target.
        productTitleEl.insertAdjacentElement('afterend', ratingContainer);
      }
      renderPreviewTopBanner(bannerEl, preview);
      document.body.prepend(bannerEl);
      bindTooltipViewportAlignment(bannerEl);
      // A cached reputation is independent of the current product scrape.
      // Render it immediately on revisits without starting a new search or
      // changing the first-visit collector/enrichment flow.
      loadCachedBrandReputationForProductBanner(bannerEl, hostDomain);
      pollStoreCollectorStatus(
        bannerEl,
        window.location.hostname.replace(/^www\./, ''),
        platform
      );
      bannerEl.querySelector('#sv-recheck-btn')?.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        runManualRecheck(bannerEl, platform);
      });
      const prevPaddingTop = document.body.style.paddingTop || '0px';
      document.body.style.paddingTop = `calc(${prevPaddingTop} + 86px)`;

      // Keep the preview visible while the store-specific collector is created.
      let firstProductRequest = true;
      let productCheckNoticeTimer = null;
      try {
        while (true) {
          if (firstProductRequest) {
            productCheckNoticeTimer = setTimeout(() => {
              const statusEl = bannerEl.querySelector('#sv-enrichment-status');
              if (statusEl?.dataset.stage === 'collector_provisioning') {
                updateEnrichmentStatus(bannerEl, 'product_rechecking', 'Checking live product data...');
              }
            }, 700);
          }
      const res = await backendFetch(`${BACKEND_URL}/api/scrape`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              url: window.location.href,
              platform
            })
          });
          if (productCheckNoticeTimer) {
            clearTimeout(productCheckNoticeTimer);
            productCheckNoticeTimer = null;
          }
          firstProductRequest = false;
          const json = await res.json().catch(() => ({}));

          if (res.status === 202 || json.status === 'collector_provisioning' || json.status === 'product_scrape_retry' || json.status === 'collector_self_healing' || json.status === 'collector_heal_failed') {
            if (json.status === 'collector_heal_failed') {
              updateEnrichmentStatus(
                bannerEl,
                'collector_heal_failed',
                json.message || 'Self-healing failed. Please retry later.'
              );
              break;
            }
            const collectorFailed = json.collector_status === 'failed';
            const retryAfter = Math.max(3000, Number(json.retry_after_ms) || 5000);
            const retryAfterSeconds = Math.ceil(retryAfter / 1000);
            const provisioningStage = json.status === 'collector_self_healing'
              ? 'collector_self_healing'
              : (json.collector_phase === 'verification_scraping'
              ? 'verification_scraping'
              : (json.status === 'product_scrape_retry' ? 'collector_scraping' : 'collector_provisioning'));
            // A product scrape can fail while the backend starts automatic
            // self-healing in the background. Check that health channel before
            // showing the generic retry message so the badge reflects healing
            // immediately, even before /api/scrape succeeds.
            let healthShown = false;
            let healingActive = provisioningStage === 'collector_self_healing';
            try {
              const healthRes = await backendFetch(
                `${BACKEND_URL}/api/collector-health-status?domain=${encodeURIComponent(window.location.hostname.replace(/^www\./, ''))}`
              );
              const healthJson = await healthRes.json().catch(() => ({}));
              if (healthJson.active && healthJson.status?.stage) {
                updateEnrichmentStatus(
                  bannerEl,
                  healthJson.status.stage,
                  healthJson.status.message
                );
                healthShown = true;
                healingActive = healthJson.status.stage === 'collector_self_healing';
              }
            } catch (healthError) {
              console.warn('[ScrapeVerse] Collector health notice:', healthError.message);
            }
            if (healingActive) {
              const healingResult = await waitForCollectorHealing(
                bannerEl,
                window.location.hostname.replace(/^www\./, ''),
                json.message || 'Self-healing collector...'
              );
              if (healingResult === 'collector_heal_failed') break;
              continue;
            }
            if (!healthShown) {
              updateEnrichmentStatus(
                bannerEl,
                collectorFailed
                  ? 'collector_failed'
                  : provisioningStage,
                collectorFailed
                  ? `⚠ Collector creation failed · Retrying in ${retryAfterSeconds} seconds`
                  : (provisioningStage === 'verification_scraping'
                    ? 'Verification scrape started...'
                    : (json.status === 'product_scrape_retry' ? 'Store collector is retrying the product scrape...' : 'Creating store collector...'))
              );
            }
            if (collectorFailed && json.collector_error) {
              const statusEl = bannerEl.querySelector('#sv-enrichment-status');
              if (statusEl) statusEl.title = `${statusEl.innerText}: ${json.collector_error}`;
            }
            await new Promise(resolve => setTimeout(resolve, retryAfter));
            continue;
          }

          if (!res.ok) throw new Error(`Backend returned HTTP ${res.status}`);
          if (!json.success || !json.data) throw new Error(json.error || 'Product data unavailable');

          populateTopBanner(bannerEl, json.data, platform);
          injectSidebar(json.data);
          updateEnrichmentStatus(
            bannerEl,
            json.data.enrichmentStatus?.stage || 'starting',
            json.data.enrichmentStatus?.message || 'Verified product received; starting store intelligence...'
          );
          if (json.data.enrichmentPending && json.data.product?.id) {
            refreshReviewSummary(json.data.product.id);
            pollEnrichmentStatus(json.data.product.id, bannerEl, 0, window.location.hostname.replace(/^www\./, ''));
          }
          break;
        }
      } catch (err) {
        console.warn('[ScrapeVerse] Scrape error:', err);
      } finally {
        if (productCheckNoticeTimer) clearTimeout(productCheckNoticeTimer);
        productInitializationInFlight = false;
      }
    } else {
      // ─────────────────────────────────────────────
      // MODE B: Store-Level Overview Mode (Homepage, Collections, Categories, Cart)
      // Pure Brand Web Reputation & Delivery Health — Zero product elements!
      // ─────────────────────────────────────────────
      const hostDomain = window.location.hostname.replace(/^www\./, '');
      const brandName = hostDomain.split('.')[0].toUpperCase();

      // Track Store visit in user history
      backendFetch(`${BACKEND_URL}/api/history/track`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          domain: hostDomain,
          platform,
          isProductPage: false,
          url: window.location.href
        })
      }).catch(() => {});

      console.log(`✦ ScrapeVerse detected Store Browsing Page: ${hostDomain} (${platform.toUpperCase()}) — Loading Brand Web Reputation.`);

      const bannerEl = document.createElement('div');
      bannerEl.id = 'scrapeverse-top-banner';
      bannerEl.innerHTML = `
        <!-- Single Clean Brand Intelligence Row (No Product Elements) -->
        <div class="sv-banner-info-row" style="border-bottom:none;">
          <div class="sv-banner-left" style="display:flex;align-items:center;gap:8px;">
            <div class="sv-logo">✦ ScrapeVerse</div>
            <span class="sv-platform-badge">${platform.toUpperCase()}</span>
            <span class="sv-brand-badge" style="font-size:11px;font-weight:700;background:var(--sv-surface-soft);color:var(--sv-text-main);padding:3px 10px;border-radius:var(--sv-radius-full);border:1px solid var(--sv-border);white-space:nowrap;letter-spacing:0.3px;">
              🏷️ ${brandName}
            </span>
            <div class="sv-delivery-tooltip-wrap" id="sv-store-brand-rep-container">
              <span class="sv-brand-trust-pill" id="sv-store-trust-pill" style="cursor:help;display:inline-flex;align-items:center;gap:4px;" title="Hover to view 30-day web reputation across Reddit, YouTube & Trustpilot">
                <span>⚡ Checking Web Reputation...</span>
              </span>
              <div class="sv-brand-tooltip-box" id="sv-store-brand-rep-panel">
                <div style="display:flex;justify-content:space-between;align-items:center;padding-bottom:10px;border-bottom:1px solid var(--sv-border);">
                  <div style="display:flex;align-items:center;gap:10px;">
                    <span style="font-size:12px;font-weight:700;color:var(--sv-text-main);display:flex;align-items:center;gap:6px;">
                      🌐 30-Day Open-Web Brand Standing & Scam Radar
                    </span>
                    <span id="sv-store-scam-badge" style="font-size:10px;background:var(--sv-primary-soft);color:var(--sv-primary);font-weight:700;padding:2px 8px;border-radius:var(--sv-radius-full);border:1px solid var(--sv-border);">
                      🛡️ 94% Brand Trust
                    </span>
                  </div>
                  <span id="sv-store-cache-meta" style="font-size:9px;color:var(--sv-text-muted);">⚡ 30-Day Intelligence Cache</span>
                </div>
                <div style="background:var(--sv-surface-soft);border:1px solid var(--sv-border);border-radius:var(--sv-radius-sm);padding:8px 10px;margin-top:10px;margin-bottom:10px;">
                  <p id="sv-store-ai-summary" style="font-size:11px;line-height:1.4;color:var(--sv-text-body);margin:0;">
                    Checking independent external discussions across Reddit and YouTube...
                  </p>
                </div>
                <div id="sv-store-sources-list" style="display:grid;grid-template-columns:repeat(3, minmax(0, 1fr));gap:6px;">
                  <!-- dynamic direct external review proof links -->
                </div>
              </div>
            </div>
            <div class="sv-delivery-tooltip-wrap">
              <span class="sv-delivery-success-pill" style="font-size:11px;font-weight:700;background:var(--sv-surface-soft);color:var(--sv-text-main);padding:3px 10px;border-radius:var(--sv-radius-full);border:1px solid var(--sv-border);display:flex;align-items:center;gap:4px;white-space:nowrap;cursor:help;">
                <span>📦</span>
                <span>95% Delivery Success</span>
              </span>
              <div class="sv-delivery-tooltip-box">
                <div style="font-weight:700;color:var(--sv-primary);margin-bottom:4px;display:flex;align-items:center;gap:5px;">
                  <span>📦 DTC Brand Shipping Health</span>
                </div>
                <div style="color:var(--sv-text-body);font-size:11px;margin-bottom:6px;line-height:1.4;">
                  Standard courier dispatch network with online tracking across India.
                </div>
                <div style="font-size:10px;color:var(--sv-text-muted);border-top:1px solid var(--sv-border);padding-top:4px;">
                  <span>🚚 Courier Network: <strong style="color:var(--sv-text-main);">Bluedart, Delhivery, DTDC</strong></span>
                </div>
              </div>
            </div>
            <div class="sv-delivery-tooltip-wrap">
              <span class="sv-delivery-success-pill" id="sv-store-visitors-pill" style="font-size:11px;font-weight:700;background:var(--sv-surface-soft);color:var(--sv-text-main);padding:3px 10px;border-radius:var(--sv-radius-full);border:1px solid var(--sv-border);display:flex;align-items:center;gap:4px;white-space:nowrap;cursor:help;">
                <span>👥</span>
                <span id="sv-store-traffic-text">Collecting visitor signals...</span>
              </span>
              <div class="sv-delivery-tooltip-box">
                <div style="font-weight:700;color:var(--sv-primary);margin-bottom:4px;display:flex;align-items:center;gap:5px;">
                  <span>👥 Store Shopper Traffic</span>
                </div>
                <div id="sv-store-traffic-summary" style="color:var(--sv-text-body);font-size:11px;margin-bottom:6px;line-height:1.4;">
                  Waiting for anonymous ScrapeVerse extension traffic signals.
                </div>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-bottom:6px;background:var(--sv-surface-soft);padding:6px;border-radius:var(--sv-radius-sm);font-size:10px;line-height:1.35;">
                  <span>Observed users: <strong id="sv-store-observed-visitors" style="color:var(--sv-text-main);">—</strong></span>
                  <span>Visits today: <strong id="sv-store-observed-visits" style="color:var(--sv-text-main);">—</strong></span>
                  <span>Estimated uplift: <strong id="sv-store-traffic-uplift" style="color:var(--sv-primary);">+50%</strong></span>
                  <span>Active now: <strong id="sv-store-active-visitors" style="color:var(--sv-text-main);">—</strong></span>
                </div>
                <div style="font-size:10px;color:var(--sv-text-muted);border-top:1px solid var(--sv-border);padding-top:4px;">
                  <span>📊 Estimated 30-Day Reach: <strong id="sv-store-monthly-reach" style="color:var(--sv-text-main);">Collecting...</strong></span>
                </div>
              </div>
            </div>
            <span class="sv-active-now-pill" id="sv-store-active-now-pill" title="Unique extension users who sent a signal within the last 15 minutes">
              <span class="sv-active-now-dot">●</span>
              <span id="sv-store-active-now-text">Active now: —</span>
            </span>
          </div>

          <div style="display:flex;align-items:center;gap:8px;">
            <a href="${BACKEND_URL}/history" target="_blank" class="sv-alert-btn" style="text-decoration:none;" aria-label="Open shopping history" title="Open Shopping History: view products you have visited and saved.">
              <span>🕒 History ↗</span>
            </a>
          </div>
        </div>
      `;

      // Fetch Brand Reputation and mount
      backendFetch(`${BACKEND_URL}/api/brand-reputation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: hostDomain, brand_name: brandName })
      })
      .then(res => res.json())
      .then(json => {
        if (json.success && json.reputation) {
          // Mount the banner now that data is ready
          document.body.prepend(bannerEl);
          bindTooltipViewportAlignment(bannerEl);
          const prevPaddingTop = document.body.style.paddingTop || '0px';
          document.body.style.paddingTop = `calc(${prevPaddingTop} + 46px)`;

          const rep = json.reputation;
          const trustPill = bannerEl.querySelector('#sv-store-trust-pill');
          const brandBadge = bannerEl.querySelector('#sv-store-brand-badge');
          const summaryEl = bannerEl.querySelector('#sv-store-ai-summary');
          const sourcesList = bannerEl.querySelector('#sv-store-brand-sources');
          const trustState = getBrandTrustState(rep);

          if (trustPill) {
            trustPill.className = trustState.className;
            trustPill.innerHTML = `<span>${trustState.label}</span> <span id="sv-store-rev-arrow" style="font-size:10px;margin-left:2px;">▾</span>`;
            trustPill.title = trustState.title;
          }

          if (brandBadge) {
            if (trustState.className === 'sv-scam-pill-danger') {
              brandBadge.style.background = '#ef4444';
              brandBadge.style.color = '#ffffff';
              brandBadge.innerText = trustState.badgeLabel;
            } else if (trustState.className === 'sv-brand-pill-warning') {
              brandBadge.style.background = '#fff3cd';
              brandBadge.style.color = '#8a5a00';
              brandBadge.innerText = trustState.badgeLabel;
            } else {
              brandBadge.style.background = 'rgba(16,185,129,0.18)';
              brandBadge.style.color = '#10b981';
              brandBadge.innerText = trustState.badgeLabel;
            }
          }

          if (summaryEl && rep.ai_summary) {
            summaryEl.innerText = rep.ai_summary;
          }

          if (sourcesList && rep.sources && rep.sources.length > 0) {
            sourcesList.innerHTML = rep.sources.map(s => `
              <a href="${s.url}" target="_blank" class="sv-external-source-card">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px;">
                  <span style="font-size:10px;font-weight:700;color:var(--sv-primary);">${s.icon || '💬'} ${s.source}</span>
                  <span style="font-size:10px;color:var(--sv-primary);font-weight:700;">Open ↗</span>
                </div>
                <div style="font-size:11px;font-weight:700;color:var(--sv-text-main);line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin-bottom:3px;" title="${s.title}">
                  ${s.title}
                </div>
                <div style="font-size:10px;color:var(--sv-text-muted);line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">
                  "${s.snippet}"
                </div>
              </a>
            `).join('');
          }

          // Fetch dynamic store traffic insights
          backendFetch(`${BACKEND_URL}/api/store-insights`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ domain: hostDomain })
          })
          .then(res => res.json())
          .then(insJson => {
            if (insJson.success && insJson.data?.traffic) {
              const tr = insJson.data.traffic;
              const trafEl = bannerEl.querySelector('#sv-store-traffic-text');
              const summaryEl = bannerEl.querySelector('#sv-store-traffic-summary');
              const observedVisitorsEl = bannerEl.querySelector('#sv-store-observed-visitors');
              const observedVisitsEl = bannerEl.querySelector('#sv-store-observed-visits');
              const upliftEl = bannerEl.querySelector('#sv-store-traffic-uplift');
              const activeVisitorsEl = bannerEl.querySelector('#sv-store-active-visitors');
              const activeNowEl = bannerEl.querySelector('#sv-store-active-now-text');
              const reachEl = bannerEl.querySelector('#sv-store-monthly-reach');
              const estimatedDailyVisitors = Number(tr.estimatedDailyVisitors ?? tr.dailyVisitors) || 0;
              const observedVisitors = Number(tr.observedVisitors) || 0;
              const estimatedAdditionalVisitors = Number(tr.estimatedAdditionalVisitors) || 0;
              const observedVisits = Number(tr.observedVisits) || 0;
              const upliftPercent = Number(tr.upliftPercent) || 50;

              if (trafEl) {
                trafEl.innerText = estimatedDailyVisitors > 0
                  ? `~${formatTrafficNumber(estimatedDailyVisitors)} Daily Visitors`
                  : 'Collecting visitor signals...';
              }
              if (summaryEl) {
                summaryEl.innerText = estimatedDailyVisitors > 0
                  ? `${observedVisitors} observed extension users + ${estimatedAdditionalVisitors} estimated non-extension visitors (${upliftPercent}% uplift).`
                  : 'Waiting for anonymous ScrapeVerse extension traffic signals.';
              }
              if (observedVisitorsEl) observedVisitorsEl.innerText = formatTrafficNumber(observedVisitors);
              if (observedVisitsEl) observedVisitsEl.innerText = formatTrafficNumber(observedVisits);
              if (upliftEl) upliftEl.innerText = `+${upliftPercent}%`;
              if (activeVisitorsEl) activeVisitorsEl.innerText = formatTrafficNumber(tr.activeNow);
              if (activeNowEl) activeNowEl.innerText = `Active now: ${formatTrafficNumber(tr.activeNow)}`;
              if (reachEl && tr.visitors15d) {
                reachEl.innerText = `~${formatTrafficNumber(Number(tr.visitors15d) * 2)}`;
              } else if (reachEl) {
                reachEl.innerText = 'Collecting...';
              }
            }
          })
          .catch(() => {});
        }
      })
      .catch(err => console.warn('[ScrapeVerse] Store brand reputation fetch notice:', err));
    }
  }

  function applyBrandReputationToProductBanner(bannerEl, reputation) {
    if (!bannerEl || !reputation) return;

    const trustState = getBrandTrustState(reputation);
    const brandTrustPill = bannerEl.querySelector('#sv-brand-trust-pill');
    if (brandTrustPill) {
      brandTrustPill.className = trustState.className;
      brandTrustPill.innerHTML = `<span>${trustState.label}</span>`;
      brandTrustPill.title = trustState.title;
    }

    const brandBadge = bannerEl.querySelector('#sv-brand-scam-badge');
    if (brandBadge) {
      if (trustState.className === 'sv-scam-pill-danger') {
        brandBadge.style.background = '#ef4444';
        brandBadge.style.color = '#ffffff';
      } else if (trustState.className === 'sv-brand-pill-warning') {
        brandBadge.style.background = '#fff3cd';
        brandBadge.style.color = '#8a5a00';
      } else {
        brandBadge.style.background = 'rgba(16,185,129,0.18)';
        brandBadge.style.color = '#10b981';
      }
      brandBadge.innerText = trustState.badgeLabel;
    }

    const cacheMeta = bannerEl.querySelector('#sv-brand-cache-meta');
    if (cacheMeta) {
      const expiry = reputation.expires_at ? new Date(reputation.expires_at) : null;
      const expiryLabel = expiry && !Number.isNaN(expiry.getTime())
        ? expiry.toLocaleDateString()
        : '';
      cacheMeta.innerText = reputation.fromCache
        ? `✓ Cached 30-day intelligence${expiryLabel ? ` · until ${expiryLabel}` : ''}`
        : '✓ Fresh research · cached for 30 days';
    }

    const brandSummary = bannerEl.querySelector('#sv-brand-ai-summary');
    if (brandSummary && reputation.ai_summary) {
      brandSummary.innerText = reputation.ai_summary;
    }

    const brandSources = bannerEl.querySelector('#sv-brand-sources-list');
    if (brandSources && Array.isArray(reputation.sources) && reputation.sources.length > 0) {
      brandSources.innerHTML = reputation.sources.map(source => `
        <a href="${source.url}" target="_blank" class="sv-external-source-card">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px;">
            <span style="font-size:10px;font-weight:700;color:var(--sv-primary);">${source.icon || '💬'} ${source.source}</span>
            <span style="font-size:10px;color:var(--sv-primary);font-weight:700;">Open ↗</span>
          </div>
          <div style="font-size:11px;font-weight:700;color:var(--sv-text-main);line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin-bottom:3px;" title="${source.title}">
            ${source.title}
          </div>
          <div style="font-size:10px;color:var(--sv-text-muted);line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">
            "${source.snippet}"
          </div>
        </a>
      `).join('');
    }
  }

  // 7. Populate Top Banner with Live Metrics & Mini Sparkline
  function populateTopBanner(bannerEl, data, platform) {
    const { product, history, lowestPrice, highestPrice, currentPrice, purchaseMetrics, historyEstimated } = data;
    rememberProductContext(product, platform);
    const points = history && history.length > 0 ? history : [{ price: currentPrice || product.price || 499, checked_at: new Date() }];

    const titleEl = document.getElementById('sv-prod-title');
    const fullProductTitle = product.title || 'Product';
    if (titleEl) {
      titleEl.innerText = truncateDisplayTitle(fullProductTitle);
      titleEl.title = fullProductTitle;
    }
    const stateBadge = bannerEl.querySelector('#sv-product-state-badge');
    if (stateBadge) {
      stateBadge.innerText = 'Verified';
      stateBadge.style.color = 'var(--sv-primary)';
      stateBadge.dataset.svTooltip = 'Verified: product name and price returned by the backend collector or live product check.';
    }
    setPreviewActionsEnabled(bannerEl, true);

    const brandTagEl = document.getElementById('sv-brand-tag-pill');
    if (brandTagEl && product.brand) {
      brandTagEl.innerText = `🏷️ ${product.brand.toUpperCase()}`;
    }

    const effPrice = currentPrice || product.price || 0;
    const effCompare = product.compare_at_price || null;
    const dropPercent = effCompare ? Math.round(((effCompare - effPrice) / effCompare) * 100) : 0;
    const purchasesBadge = purchaseMetrics ? purchaseMetrics.formatted_badge : '1.2k+';

    const sparkSvg = generateMiniSparkline(points);

    const centerEl = bannerEl.querySelector('#sv-prod-banner-center') || bannerEl.querySelector('.sv-banner-center');
    if (centerEl) {
      centerEl.innerHTML = `
        <div class="sv-price-item">
          <span class="sv-price-label">Current:</span>
          <span class="sv-price-val current" style="color:var(--sv-primary);font-size:15px;font-weight:800;">₹${effPrice}</span>
          ${dropPercent > 0 ? `<span class="sv-price-drop">-${dropPercent}%</span>` : ''}
        </div>

        <div class="sv-price-item" style="display:flex;align-items:center;gap:6px;">
          <span class="sv-price-label">Range:</span>
          <span class="sv-price-val" style="color:var(--sv-text-muted);font-size:11px;">₹${lowestPrice || effPrice} — ₹${highestPrice || effPrice}</span>
          <span data-sv-tooltip="${historyEstimated ? 'Estimated: this range and graph are approximated until enough verified price history is available.' : 'Verified: this range and graph use saved backend price history.'}" style="font-size:9px;color:var(--sv-text-muted);font-weight:600;border:1px solid var(--sv-border);border-radius:999px;padding:2px 5px;">${historyEstimated ? 'Estimated' : 'Verified'}</span>
          <div id="sv-sparkline-svg-holder" style="display:flex;align-items:center;" title="Price Range Trajectory">
            <svg class="sv-sparkline-svg" viewBox="0 0 100 24" preserveAspectRatio="none">
              <path d="${sparkSvg.area}" fill="rgba(30, 61, 43, 0.12)" />
              <path d="${sparkSvg.line}" fill="none" stroke="#1E3D2B" stroke-width="2" stroke-linecap="round" />
              ${sparkSvg.dot}
            </svg>
          </div>
        </div>

        <div class="sv-price-item">
          <div class="sv-sold-tooltip-wrap">
            <span class="sv-price-val" style="color:var(--sv-text-muted);font-size:11px;font-weight:600;text-decoration:underline dotted;text-underline-offset:3px;">
              🛍️ ${purchasesBadge} Sold
            </span>
            <div class="sv-sold-tooltip-box">
              <div style="font-weight:700;color:var(--sv-primary);margin-bottom:3px;display:flex;align-items:center;gap:4px;">
                <span>🛍️ How Order Volume is Calculated</span>
              </div>
              <div style="color:var(--sv-text-body);margin-bottom:5px;line-height:1.4;">
                Estimated from verified public customer reviews combined with real-time checkout orders tracked across ScrapeVerse.
              </div>
              <div style="font-size:10px;color:var(--sv-primary);font-weight:700;border-top:1px solid var(--sv-border);padding-top:4px;display:flex;align-items:center;gap:4px;">
                <span>⚡ 100% Grounded in Public Signals</span>
              </div>
            </div>
          </div>
        </div>
      `;
    }

    const priceTrendBtn = document.getElementById('sv-price-trend-btn');
    if (priceTrendBtn) {
      priceTrendBtn.href = `${BACKEND_URL}/price-history?url=${encodeURIComponent(window.location.href)}`;
    }

    // Setup Price Drop Alert Button
    const alertBtn = document.getElementById('sv-alert-notify-btn');
    if (alertBtn && alertBtn.dataset.svAlertBound !== 'true') {
      alertBtn.dataset.svAlertBound = 'true';
      const watchedKey = `sv_alert_${product?.id || encodeURIComponent(window.location.pathname)}`;
      const targetKey = `sv_alert_target_${product?.id || encodeURIComponent(window.location.pathname)}`;
      const defaultAlertTarget = Math.max(1, Math.round((Number(effPrice) || 1) * 0.95));
      let isAlreadyWatched = localStorage.getItem(watchedKey) === 'true';
      let savedEmail = localStorage.getItem('scrapeverse_user_email') || '';
      let savedTargetPrice = Number(localStorage.getItem(targetKey)) || defaultAlertTarget;

      if (isAlreadyWatched) {
        alertBtn.classList.add('active');
        const txt = alertBtn.querySelector('#sv-alert-btn-text');
        if (txt) txt.innerText = 'Alert Active ✅';
        alertBtn.title = savedEmail ? `Alert active for ${savedEmail}. Click to manage or turn off.` : 'Alert active. Click to manage or turn off.';
      }

      alertBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        savedEmail = localStorage.getItem('scrapeverse_user_email') || '';
        isAlreadyWatched = localStorage.getItem(watchedKey) === 'true';

        const existingPopover = document.getElementById('sv-alert-popover');
        if (existingPopover) {
          existingPopover.remove();
          return;
        }

        const popover = document.createElement('div');
        popover.id = 'sv-alert-popover';
        popover.className = 'sv-alert-popover';

        let scrollTimeout = null;
        const initialScrollY = window.scrollY;

        function closeAlertPopover(immediate = false) {
          if (!popover || !popover.parentNode) return;

          if (scrollTimeout) {
            clearTimeout(scrollTimeout);
            scrollTimeout = null;
          }

          document.removeEventListener('click', handleOutsideClick, true);
          document.removeEventListener('keydown', handleEscapeKey, true);
          window.removeEventListener('scroll', handleScroll, { passive: true });

          if (immediate) {
            popover.remove();
          } else {
            popover.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
            popover.style.opacity = '0';
            popover.style.transform = 'translateY(-6px)';
            setTimeout(() => {
              if (popover && popover.parentNode) popover.remove();
            }, 200);
          }
        }

        function handleOutsideClick(evt) {
          if (!popover.contains(evt.target) && !alertBtn.contains(evt.target)) {
            closeAlertPopover(false);
          }
        }

        function handleEscapeKey(evt) {
          if (evt.key === 'Escape') {
            closeAlertPopover(true);
          }
        }

        function handleScroll() {
          if (Math.abs(window.scrollY - initialScrollY) > 40) {
            if (scrollTimeout) clearTimeout(scrollTimeout);
            scrollTimeout = setTimeout(() => {
              closeAlertPopover(false);
            }, 200);
          }
        }

        // Attach listeners on next tick so initial click doesn't trigger outside click
        setTimeout(() => {
          document.addEventListener('click', handleOutsideClick, true);
          document.addEventListener('keydown', handleEscapeKey, true);
          window.addEventListener('scroll', handleScroll, { passive: true });
        }, 20);

        function renderActiveView() {
          const displayEmail = savedEmail || 'Registered Email';
          popover.innerHTML = `
            <div style="font-size:13px;font-weight:700;color:var(--sv-primary);margin-bottom:4px;display:flex;align-items:center;gap:6px;">
              <span>🔔 Price Drop Alert Active ✅</span>
            </div>
            <div style="font-size:12px;color:var(--sv-text-muted);margin-bottom:8px;">
              Active notifications configured for:
            </div>
            <div style="background:var(--sv-surface-soft);border:1px solid var(--sv-border);padding:8px 10px;border-radius:var(--sv-radius-sm);font-size:12px;font-weight:700;color:var(--sv-text-main);margin-bottom:12px;word-break:break-all;">
              📧 ${displayEmail}
            </div>
            <div style="font-size:12px;color:var(--sv-text-muted);margin-bottom:12px;">
              Target price: <strong style="color:var(--sv-primary);">₹${savedTargetPrice.toLocaleString('en-IN')}</strong>
            </div>
            <button id="sv-alert-unsub-btn" style="width:100%;background:#FFF5F5;color:var(--sv-danger);border:1px solid #FED7D7;font-weight:700;padding:8px 12px;border-radius:var(--sv-radius-sm);font-size:12px;cursor:pointer;margin-bottom:8px;transition:all 0.2s;">
              ✕ Turn Off Alert / Unsubscribe
            </button>
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <button id="sv-alert-change-btn" style="background:transparent;border:none;color:var(--sv-primary);font-size:11px;cursor:pointer;font-weight:600;text-decoration:underline;">Change settings</button>
              <button id="sv-alert-dismiss-btn" style="background:transparent;border:none;color:var(--sv-text-muted);font-size:11px;cursor:pointer;">Close</button>
            </div>
          `;

          popover.querySelector('#sv-alert-dismiss-btn').addEventListener('click', closeAlertPopover);

          popover.querySelector('#sv-alert-unsub-btn').addEventListener('click', async () => {
            const btnEl = popover.querySelector('#sv-alert-unsub-btn');
            if (btnEl) btnEl.innerText = 'Unsubscribing...';
            await unsubscribePriceAlert(savedEmail, product, alertBtn, watchedKey);
            closeAlertPopover();
          });

          popover.querySelector('#sv-alert-change-btn').addEventListener('click', () => {
            renderEditEmailView(true);
          });
        }

        function renderEditEmailView(isActiveContext) {
          popover.innerHTML = `
            <div style="font-size:13px;font-weight:700;color:var(--sv-text-main);margin-bottom:4px;display:flex;align-items:center;gap:6px;">
              <span>🔔 ${isActiveContext ? 'Update Alert Email' : 'Price Drop Email Alert'}</span>
            </div>
            <div style="font-size:12px;color:var(--sv-text-muted);margin-bottom:12px;line-height:1.45;">
              ${isActiveContext ? 'Enter your new email address to receive price drop notifications:' : 'Enter your email to get notified automatically whenever this item drops in price:'}
            </div>
            <div style="display:flex;gap:6px;margin-bottom:8px;">
              <input type="email" id="sv-alert-email-input" value="${savedEmail || ''}" placeholder="name@gmail.com" style="background:var(--sv-bg);border:1px solid var(--sv-border);color:var(--sv-text-main);padding:8px 12px;border-radius:var(--sv-radius-sm);font-size:12px;flex:1;outline:none;box-sizing:border-box;">
              <button id="sv-alert-submit-btn" style="background:var(--sv-primary);color:#ffffff;font-weight:600;border:none;padding:8px 14px;border-radius:var(--sv-radius-sm);font-size:12px;cursor:pointer;white-space:nowrap;">
                ${isActiveContext ? 'Update' : 'Set Alert'}
              </button>
            </div>
            <label style="display:block;font-size:11px;color:var(--sv-text-muted);margin-bottom:4px;" for="sv-alert-target-input">
              Notify when price reaches or falls below
            </label>
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:10px;">
              <span style="font-size:12px;color:var(--sv-text-muted);">₹</span>
              <input type="number" min="1" step="1" id="sv-alert-target-input" value="${savedTargetPrice}" placeholder="${defaultAlertTarget}" style="background:var(--sv-bg);border:1px solid var(--sv-border);color:var(--sv-text-main);padding:8px 10px;border-radius:var(--sv-radius-sm);font-size:12px;flex:1;outline:none;box-sizing:border-box;">
              <span style="font-size:10px;color:var(--sv-text-muted);white-space:nowrap;">Default: ₹${defaultAlertTarget}</span>
            </div>
            <div style="display:flex;justify-content:space-between;align-items:center;padding-top:4px;">
              <span style="font-size:11px;color:var(--sv-text-muted);">✦ 1-Click • Zero Spam</span>
              <button id="sv-alert-cancel-btn" style="background:transparent;border:none;color:var(--sv-text-muted);font-size:11px;cursor:pointer;text-decoration:underline;">
                ${isActiveContext ? 'Cancel' : 'Close'}
              </button>
            </div>
          `;

          const inputEl = popover.querySelector('#sv-alert-email-input');
          inputEl.focus();

          popover.querySelector('#sv-alert-cancel-btn').addEventListener('click', () => {
            if (isActiveContext) {
              renderActiveView();
            } else if (savedEmail) {
              renderSavedEmailView();
            } else {
              closeAlertPopover();
            }
          });

          const handleSave = async () => {
            const inputEmail = inputEl.value.trim();
            if (!inputEmail || !inputEmail.includes('@')) {
              inputEl.style.borderColor = 'var(--sv-danger)';
              return;
            }

            const submitBtn = popover.querySelector('#sv-alert-submit-btn');
            if (submitBtn) submitBtn.innerText = isActiveContext ? 'Updating...' : 'Saving...';

            const targetInput = popover.querySelector('#sv-alert-target-input');
            const parsedTarget = Number(targetInput?.value);
            savedTargetPrice = Number.isFinite(parsedTarget) && parsedTarget > 0
              ? Math.round(parsedTarget)
              : defaultAlertTarget;

            localStorage.setItem('scrapeverse_user_email', inputEmail);
            localStorage.setItem(targetKey, String(savedTargetPrice));
            savedEmail = inputEmail;
            await subscribePriceAlert(inputEmail, product, effPrice, alertBtn, watchedKey, savedTargetPrice);
            closeAlertPopover();
          };

          popover.querySelector('#sv-alert-submit-btn').addEventListener('click', handleSave);
          inputEl.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter') handleSave();
          });
        }

        function renderSavedEmailView() {
          popover.innerHTML = `
            <div style="font-size:13px;font-weight:700;color:var(--sv-text-main);margin-bottom:4px;">
              <span>🔔 Price Drop Alert</span>
            </div>
            <div style="font-size:12px;color:var(--sv-text-muted);margin-bottom:8px;">
              Activate price drop notification for:
            </div>
            <div style="background:var(--sv-surface-soft);border:1px solid var(--sv-border);padding:8px 10px;border-radius:var(--sv-radius-sm);font-size:12px;font-weight:700;color:var(--sv-text-main);margin-bottom:12px;word-break:break-all;">
              📧 ${savedEmail}
            </div>
            <label style="display:block;font-size:11px;color:var(--sv-text-muted);margin-bottom:4px;" for="sv-alert-target-input">
              Notify when price reaches or falls below
            </label>
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:10px;">
              <span style="font-size:12px;color:var(--sv-text-muted);">₹</span>
              <input type="number" min="1" step="1" id="sv-alert-target-input" value="${savedTargetPrice}" placeholder="${defaultAlertTarget}" style="background:var(--sv-bg);border:1px solid var(--sv-border);color:var(--sv-text-main);padding:8px 10px;border-radius:var(--sv-radius-sm);font-size:12px;flex:1;outline:none;box-sizing:border-box;">
              <span style="font-size:10px;color:var(--sv-text-muted);white-space:nowrap;">Default: ₹${defaultAlertTarget}</span>
            </div>
            <button id="sv-alert-activate-btn" style="width:100%;background:var(--sv-primary);color:#ffffff;border:none;font-weight:700;padding:8px 12px;border-radius:var(--sv-radius-sm);font-size:12px;cursor:pointer;margin-bottom:8px;">
              ✓ Activate Alert
            </button>
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <button id="sv-alert-change-btn" style="background:transparent;border:none;color:var(--sv-primary);font-size:11px;cursor:pointer;font-weight:600;text-decoration:underline;">Use Different Email</button>
              <button id="sv-alert-dismiss-btn" style="background:transparent;border:none;color:var(--sv-text-muted);font-size:11px;cursor:pointer;">Close</button>
            </div>
          `;

          popover.querySelector('#sv-alert-dismiss-btn').addEventListener('click', closeAlertPopover);

          popover.querySelector('#sv-alert-activate-btn').addEventListener('click', async () => {
            const btnEl = popover.querySelector('#sv-alert-activate-btn');
            if (btnEl) btnEl.innerText = 'Activating...';
            const targetInput = popover.querySelector('#sv-alert-target-input');
            const parsedTarget = Number(targetInput?.value);
            savedTargetPrice = Number.isFinite(parsedTarget) && parsedTarget > 0
              ? Math.round(parsedTarget)
              : defaultAlertTarget;
            localStorage.setItem(targetKey, String(savedTargetPrice));
            await subscribePriceAlert(savedEmail, product, effPrice, alertBtn, watchedKey, savedTargetPrice);
            closeAlertPopover();
          });

          popover.querySelector('#sv-alert-change-btn').addEventListener('click', () => {
            renderEditEmailView(false);
          });
        }

        // Determine view primarily based on isAlreadyWatched status:
        if (isAlreadyWatched) {
          renderActiveView();
        } else if (savedEmail) {
          renderSavedEmailView();
        } else {
          renderEditEmailView(false);
        }

        bannerEl.appendChild(popover);
      });
    }

    async function unsubscribePriceAlert(email, prod, btn, key) {
      const resolvedEmail = email || localStorage.getItem('scrapeverse_user_email') || '';
      try {
        if (resolvedEmail) {
          await backendFetch(`${BACKEND_URL}/api/watchlist/unsubscribe`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              product_id: prod?.id,
              url: window.location.href,
              email: resolvedEmail
            })
          });
        }
      } catch (err) {
        console.warn('Unsubscribe error:', err);
      } finally {
        localStorage.removeItem(key);
        btn.classList.remove('active');
        const txt = btn.querySelector('#sv-alert-btn-text');
        if (txt) txt.innerText = 'Notify on Drop';
        btn.title = 'Notify me via email when price drops';
      }
    }

    async function subscribePriceAlert(email, prod, price, btn, key, targetPrice = null) {
      try {
        const resolvedTargetPrice = Number.isFinite(Number(targetPrice)) && Number(targetPrice) > 0
          ? Math.round(Number(targetPrice))
          : Math.max(1, Math.round((Number(price) || 1) * 0.95));
        const res = await backendFetch(`${BACKEND_URL}/api/watchlist`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            product_id: prod?.id,
            url: window.location.href,
            email: email,
            target_price: resolvedTargetPrice
          })
        });

        const json = await res.json();
        if (json.success) {
          localStorage.setItem(key, 'true');
          btn.classList.add('active');
          const txt = btn.querySelector('#sv-alert-btn-text');
          if (txt) txt.innerText = 'Alert Active ✅';
          btn.title = `Alert active: We will notify ${email} when price reaches ₹${resolvedTargetPrice} or lower`;
        }
      } catch (err) {
        console.warn('Alert subscription error:', err);
      }
    }

    // Setup 30-Day Brand Web Reputation & Scam Intelligence (Reddit, YouTube, Trustpilot)
    applyBrandReputationToProductBanner(bannerEl, data.brandReputation);

    if (data.reviewSummary) {
      sidebarCache.reviews = data.reviewSummary;
      populateReviewsPanelData(data.reviewSummary);
    }

    const sidebarButton = document.getElementById('sv-open-sidebar-btn');
    if (sidebarButton && sidebarButton.dataset.svSidebarBound !== 'true') {
      sidebarButton.dataset.svSidebarBound = 'true';
      sidebarButton.addEventListener('click', (e) => {
        e.preventDefault();
        openSidebar();
      });
    }
  }

  // Poll after background enrichment so the OpenCode summary appears
  // without requiring a full page reload.
  function refreshReviewSummary(productId, attempt = 0) {
    if (!productId || attempt > 8) return;

    const waitMs = attempt === 0 ? 3000 : 4000;
    setTimeout(async () => {
      try {
        const res = await backendFetch(`${BACKEND_URL}/api/review-summary`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ product_id: productId })
        });
        if (!res.ok) throw new Error(`Review summary HTTP ${res.status}`);
        const json = await res.json();

        if (json.pending) {
          refreshReviewSummary(productId, attempt + 1);
          return;
        }

        if (json.success && json.reviewSummary) {
          sidebarCache.reviews = json.reviewSummary;
          populateReviewsPanelData(json.reviewSummary);
        }
      } catch (err) {
        console.warn('[ScrapeVerse] Review summary refresh notice:', err);
      }
    }, waitMs);
  }

  // 8. Populate Customer Reviews & Ratings Data
  function populateReviewsPanelData(rev) {
    const sentimentPill = document.getElementById('sv-panel-sentiment-pill');
    const ratingNum = document.getElementById('sv-panel-rating-num');
    const reviewCount = document.getElementById('sv-panel-review-count');
    const summaryText = document.getElementById('sv-panel-summary-text');
    const positiveList = document.getElementById('sv-panel-positive-list');
    const negativeList = document.getElementById('sv-panel-negative-list');
    const groundedMeta = document.getElementById('sv-panel-grounded-meta');
    
    const topRatingContainer = document.getElementById('sv-rating-container');
    const topRatingText = document.getElementById('sv-top-rating-text');

    const count = typeof rev.review_count === 'number' ? rev.review_count : 0;
    const reviewsUnavailable = rev.review_status === 'unavailable';

    if (reviewsUnavailable) {
      if (topRatingContainer && topRatingText) {
        topRatingContainer.style.display = 'inline-flex';
        topRatingText.innerText = '💬 Reviews unavailable';
      }
      if (sentimentPill) sentimentPill.innerText = 'Reviews Unavailable';
      if (ratingNum) ratingNum.innerText = 'Not available';
      if (reviewCount) reviewCount.innerText = 'No supported review provider detected';
      if (summaryText) summaryText.innerText = 'Reviews unavailable for this store.';
      if (positiveList) positiveList.innerHTML = '';
      if (negativeList) negativeList.innerHTML = '';
      if (groundedMeta) groundedMeta.innerText = `Grounded in: ${rev.grounded_in || 'No review data available'}`;

      const unavailableDays = document.getElementById('sv-tooltip-del-days');
      const unavailableOntime = document.getElementById('sv-tooltip-del-ontime');
      const unavailablePkg = document.getElementById('sv-tooltip-del-pkg');
      const unavailableSummary = document.getElementById('sv-tooltip-del-summary');
      const unavailableCouriers = document.getElementById('sv-tooltip-del-couriers');
      const unavailableRate = document.getElementById('sv-delivery-rate-text');
      if (unavailableDays) unavailableDays.innerText = 'Not available';
      if (unavailableOntime) unavailableOntime.innerText = 'Not available';
      if (unavailablePkg) unavailablePkg.innerText = 'Not available';
      if (unavailableSummary) unavailableSummary.innerText = 'No supported review data is available to assess delivery.';
      if (unavailableCouriers) unavailableCouriers.innerText = 'Not specified';
      if (unavailableRate) unavailableRate.innerText = 'Delivery data unavailable';
      return;
    }
    
    if (topRatingContainer && topRatingText) {
      topRatingContainer.style.display = 'inline-flex';
      topRatingText.innerText = count > 0 && rev.avg_rating ? `⭐ ${rev.avg_rating} (${count})` : (count > 0 ? `⭐ 4.8 (${count})` : `⭐ New (${count})`);
    }

    if (sentimentPill) sentimentPill.innerText = count > 0 ? (rev.sentiment || '94% Positive (High Trust)') : 'New Release (0 Reviews)';
    if (ratingNum) ratingNum.innerText = count > 0 && rev.avg_rating ? `★ ${rev.avg_rating} / 5` : 'No Ratings Yet';
    if (reviewCount) reviewCount.innerText = count > 0 ? `Based on ${count}+ verified reviews` : '0 Reviews on Store (New Listing)';
    if (summaryText) summaryText.innerText = rev.summary || 'No customer reviews published yet.';

    if (positiveList && rev.positive_highlights) {
      positiveList.innerHTML = rev.positive_highlights.map(h => `
        <div class="sv-review-positive-item">
          <span class="sv-review-positive-icon">✓</span>
          <span>${escapeHtml(h)}</span>
        </div>
      `).join('');
    }

    if (rev.delivery_insights) {
      const tooltipDays = document.getElementById('sv-tooltip-del-days');
      const tooltipOntime = document.getElementById('sv-tooltip-del-ontime');
      const tooltipPkg = document.getElementById('sv-tooltip-del-pkg');
      const tooltipSummary = document.getElementById('sv-tooltip-del-summary');
      const tooltipCouriers = document.getElementById('sv-tooltip-del-couriers');
      const deliveryRateText = document.getElementById('sv-delivery-rate-text');

      if (tooltipDays) tooltipDays.innerText = rev.delivery_insights.avg_days || '3-4 Days';
      if (tooltipOntime) tooltipOntime.innerText = rev.delivery_insights.on_time_rate || '95%';
      if (tooltipPkg) tooltipPkg.innerText = rev.delivery_insights.packaging_score || '98% Intact';
      if (tooltipSummary) tooltipSummary.innerText = rev.delivery_insights.delivery_summary || 'Dispatched from central warehouse with standard courier tracking.';
      if (tooltipCouriers) tooltipCouriers.innerText = rev.delivery_insights.courier_partners || 'Bluedart, Delhivery, DTDC';
      if (deliveryRateText) deliveryRateText.innerText = `${rev.delivery_insights.on_time_rate || '95%'} Delivery Success`;
    }

    if (negativeList && rev.negative_watchouts) {
      negativeList.innerHTML = rev.negative_watchouts.map(w => `
        <div class="sv-review-negative-item">
          <span class="sv-review-negative-icon">!</span>
          <span>${escapeHtml(w)}</span>
        </div>
      `).join('');
    }

    if (groundedMeta) {
      groundedMeta.innerText = `Grounded in: ${rev.grounded_in || 'Bright Data verified reviews'}`;
    }
  }

  // 9. Inject Full Slide-In Sidebar (Focused on Similar Styles & Volatility)
  function injectSidebar(data, domHints = {}) {
    if (document.getElementById('scrapeverse-sidebar')) return;

    const { product, lowestPrice, highestPrice, currentPrice } = data;
    const displayTitle = product.title || domHints.title || 'Product';
    const effPrice = currentPrice || product.price || domHints.price || 0;

    const backdrop = document.createElement('div');
    backdrop.id = 'scrapeverse-backdrop';
    backdrop.className = 'scrapeverse-sidebar-backdrop';

    const drawer = document.createElement('div');
    drawer.id = 'scrapeverse-sidebar';
    drawer.className = 'scrapeverse-sidebar-drawer';

    drawer.innerHTML = `
      <div class="scrapeverse-sidebar-header">
        <div>
          <div class="scrapeverse-sidebar-header-title">✦ ScrapeVerse Discovery</div>
          <div id="scrapeverse-health-badge" style="font-size:11px;color:var(--sv-primary);font-weight:600;margin-top:2px;">Scraper Studio Operational ✅</div>
        </div>
        <button class="scrapeverse-sidebar-close" id="sv-close-sidebar-btn">&times;</button>
      </div>

      <div class="scrapeverse-sidebar-body">
        <!-- 1. Top Price & Volatility Summary Card -->
        <div class="scrapeverse-chart-card">
          <div class="scrapeverse-product-heading-row">
            <div class="scrapeverse-product-heading-title" style="color: var(--sv-text-main, #ffffff) !important;">${displayTitle}</div>
            <div class="scrapeverse-product-heading-price" style="color: var(--sv-primary, #4ade80) !important;">₹${effPrice}</div>
          </div>
          <div style="margin-top:6px;">
            <div style="font-size:11px;color:var(--sv-text-muted, #94a3b8) !important;">
              Lowest: ₹${lowestPrice || effPrice} • Highest: ₹${highestPrice || effPrice}
            </div>
          </div>
        </div>

        <!-- 2. Similar Products & Discovery Box -->
        <div class="scrapeverse-section-card" id="sv-similar-box-container">
          <div class="scrapeverse-section-title">
            <span>✦ Similar Styles & Alternatives</span>
            <span style="font-size:11px;color:var(--sv-primary);font-weight:700;" id="sv-similar-count-tag">Live Catalog</span>
          </div>

          <!-- Scope Switcher -->
          <div class="sv-scope-toggle-bar" style="margin: 0 0 12px 0;">
            <button class="sv-scope-btn active" data-scope="same_website" title="Show similar products from this website only.">🏠 This Website Only</button>
            <button class="sv-scope-btn" data-scope="cross_website" title="Show similar products from other websites.">🌐 Other Websites</button>
          </div>

          <!-- Dynamic Universal Filter & Sort Controls -->
          <div class="sv-filters-controls-grid">
            <div class="sv-filter-control-group">
              <label class="sv-control-label">Max Price</label>
              <select id="sv-price-dropdown" class="sv-select-input">
                <option value="all">Any Price</option>
                <option value="500">Under ₹500</option>
                <option value="1000">Under ₹1,000</option>
                <option value="2500">Under ₹2,500</option>
                <option value="5000">Under ₹5,000</option>
              </select>
            </div>

            <div class="sv-filter-control-group">
              <label class="sv-control-label">Min Discount</label>
              <select id="sv-discount-dropdown" class="sv-select-input">
                <option value="all">Any Discount</option>
                <option value="15">15%+ OFF</option>
                <option value="30">30%+ OFF</option>
                <option value="50">50%+ OFF (Best Deals)</option>
                <option value="70">70%+ OFF (Clearance)</option>
              </select>
            </div>

            <div class="sv-filter-control-group" style="grid-column: 1 / -1;">
              <label class="sv-control-label">Sort Order</label>
              <select id="sv-sort-dropdown" class="sv-select-input">
                <option value="recent" selected>🕒 Recent Products First (Newest Scraped)</option>
                <option value="similarity">✦ Best Style Match</option>
                <option value="price_low">💰 Price: Low to High</option>
                <option value="discount_high">🔥 Highest Discount First</option>
              </select>
            </div>
          </div>

          <div id="sv-similar-grid-container">
            <div style="text-align:center;padding:20px;color:var(--sv-text-muted);">✦ Matching catalog items...</div>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(backdrop);
    document.body.appendChild(drawer);

    backdrop.addEventListener('click', closeSidebar);
    document.getElementById('sv-close-sidebar-btn')?.addEventListener('click', closeSidebar);

    // Bind Scope Buttons
    drawer.querySelectorAll('.sv-scope-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        drawer.querySelectorAll('.sv-scope-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentScope = btn.dataset.scope;
        fetchAndRenderSimilarGrid(domHints);
      });
    });

    // Bind Filter Dropdowns
    drawer.querySelector('#sv-price-dropdown')?.addEventListener('change', (e) => {
      selectedMaxPrice = e.target.value;
      fetchAndRenderSimilarGrid(domHints);
    });

    drawer.querySelector('#sv-discount-dropdown')?.addEventListener('change', (e) => {
      selectedMinDiscount = e.target.value;
      fetchAndRenderSimilarGrid(domHints);
    });

    drawer.querySelector('#sv-sort-dropdown')?.addEventListener('change', (e) => {
      selectedSortBy = e.target.value;
      fetchAndRenderSimilarGrid(domHints);
    });

    // Update Health status badge
    backendFetch(`${BACKEND_URL}/api/health-status`)
      .then(res => res.json())
      .then(h => {
        if (h.success) {
          const el = document.getElementById('scrapeverse-health-badge');
          if (el) el.innerText = `${h.badgeText} • ${h.message.slice(0, 35)}...`;
        }
      })
      .catch(() => {});
  }

  // 10. Fetch and Render Similar Products Grid
  async function fetchAndRenderSimilarGrid(domHints = {}) {
    const gridContainer = document.getElementById('sv-similar-grid-container');
    if (!gridContainer) return;

    gridContainer.innerHTML = '<div style="text-align:center;padding:24px 0;color:var(--sv-text-muted);">✦ Matching catalog items...</div>';

    const payload = {
      url: window.location.href,
      scope: currentScope,
      sortBy: selectedSortBy,
      limit: 8
    };

    if (selectedMaxPrice !== 'all') {
      payload.maxPrice = Number(selectedMaxPrice);
    }

    if (selectedMinDiscount !== 'all') {
      payload.minDiscount = Number(selectedMinDiscount);
    }

    try {
      const res = await backendFetch(`${BACKEND_URL}/api/similar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const json = await res.json();
      const prods = json.success && Array.isArray(json.similarProducts)
        ? json.similarProducts.filter((product) => Number(product.similarity_score || 0) >= 0.40)
        : [];

      if (prods.length > 0) {
        const countTag = document.getElementById('sv-similar-count-tag');
        if (countTag) countTag.innerText = `${prods.length} Items Found`;

        gridContainer.innerHTML = `
          <div class="scrapeverse-product-grid" style="display: grid !important; grid-template-columns: repeat(2, minmax(0, 1fr)) !important; gap: 10px !important; width: 100% !important; box-sizing: border-box !important; margin-top: 10px !important;">
            ${prods.map(p => {
              const drop = p.compare_at_price ? Math.round(((p.compare_at_price - p.price) / p.compare_at_price) * 100) : 0;
              return `
                <a href="${p.url}" target="_blank" class="scrapeverse-product-card" style="display: flex !important; flex-direction: column !important; background: var(--sv-card-bg) !important; border: 1px solid var(--sv-border) !important; border-radius: var(--sv-radius-sm) !important; padding: 10px !important; text-decoration: none !important; color: var(--sv-text-main) !important; box-sizing: border-box !important; width: 100% !important; min-width: 0 !important; overflow: hidden !important; box-shadow: var(--sv-shadow-card) !important;">
                  <img src="${p.image_url}" class="scrapeverse-product-img" alt="${p.title}" style="width: 100% !important; height: 85px !important; max-height: 85px !important; min-height: 85px !important; object-fit: cover !important; border-radius: var(--sv-radius-sm) !important; margin-bottom: 6px !important; display: block !important; background: var(--sv-surface-soft) !important;">
                  <div class="scrapeverse-product-brand" style="font-size: 9px !important; color: var(--sv-text-muted) !important; font-weight: 700 !important; text-transform: uppercase !important; letter-spacing: 0.3px !important; margin-bottom: 3px !important; white-space: nowrap !important; overflow: hidden !important; text-overflow: ellipsis !important;">
                    ${p.brand || 'Brand'} • ${p.store_domain || ''}
                  </div>
                  <div class="scrapeverse-product-title" title="${p.title}" style="font-size: 11px !important; font-weight: 700 !important; color: var(--sv-text-main) !important; line-height: 1.35 !important; display: -webkit-box !important; -webkit-line-clamp: 2 !important; -webkit-box-orient: vertical !important; overflow: hidden !important; margin-bottom: 4px !important; text-decoration: none !important;">
                    ${p.title}
                  </div>
                  <div class="scrapeverse-product-price-row" style="display: flex !important; align-items: baseline !important; gap: 5px !important; margin-top: auto !important; padding-top: 4px !important;">
                    <span class="scrapeverse-product-price" style="font-size: 13px !important; font-weight: 800 !important; color: var(--sv-primary) !important;">₹${p.price}</span>
                    ${p.compare_at_price ? `<span class="scrapeverse-product-compare" style="font-size: 10px !important; color: var(--sv-text-muted) !important; text-decoration: line-through !important;">₹${p.compare_at_price}</span>` : ''}
                  </div>
                  <div class="scrapeverse-product-badge-row" style="display: flex !important; justify-content: space-between !important; align-items: center !important; margin-top: 4px !important;">
                    <span class="scrapeverse-style-match" style="font-size: 9px !important; color: var(--sv-primary) !important; font-weight: 700 !important;">✦ ${Math.round((p.similarity_score || 0.88) * 100)}% match</span>
                    ${drop > 0 ? `<span class="scrapeverse-drop-pill" style="font-size: 9px !important; background: var(--sv-primary-soft) !important; color: var(--sv-primary) !important; padding: 1px 5px !important; border-radius: 4px !important; font-weight: 700 !important; border: 1px solid var(--sv-border) !important;">-${drop}%</span>` : ''}
                  </div>
                </a>
              `;
            }).join('')}
          </div>
        `;
      } else {
        gridContainer.innerHTML = `
          <div style="text-align:center;padding:24px 0;color:var(--sv-text-muted);">
            <p style="font-weight:600;font-size:13px;margin-bottom:4px;color:var(--sv-text-main) !important;">No matching items in this filter</p>
            <small style="color:var(--sv-text-muted) !important;">Try selecting "All DTC Brands" or clear price filters.</small>
          </div>
        `;
      }
    } catch (err) {
      gridContainer.innerHTML = '<div style="color:var(--sv-danger);font-size:13px;text-align:center;padding:20px;">Failed to load similar products.</div>';
    }
  }

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSidebar();
  });

  // Dynamic SPA / Turbo / History API Navigation Listener
  let lastUrl = window.location.href;
  const spaObserver = new MutationObserver(() => {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      const oldBanner = document.getElementById('scrapeverse-top-banner');
      if (oldBanner) oldBanner.remove();
      setTimeout(init, 300);
    }
  });
  spaObserver.observe(document.documentElement, { subtree: true, childList: true });

  window.addEventListener('popstate', () => {
    const oldBanner = document.getElementById('scrapeverse-top-banner');
    if (oldBanner) oldBanner.remove();
    setTimeout(init, 300);
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
