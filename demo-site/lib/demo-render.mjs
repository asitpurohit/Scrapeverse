function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function money(value, currency) {
  return currency === 'INR' ? `₹${Number(value).toLocaleString('en-IN')}` : `${currency} ${value}`;
}

function productPath(state) {
  return `/products/${state.handle}`;
}

export function buildProductJson(state, origin) {
  return {
    id: state.product_id,
    title: state.title,
    vendor: state.brand,
    product_type: state.category,
    handle: state.handle,
    url: `${origin}${productPath(state)}`,
    featured_image: 'https://images.unsplash.com/photo-1611652022419-a9419f74343d?auto=format&fit=crop&w=1000&q=85',
    variants: [{
      id: `${state.product_id}-variant-1`,
      title: 'Default',
      price: String(state.price),
      compare_at_price: String(state.compare_at_price),
      available: true
    }]
  };
}

function normalLayout(state, product, origin) {
  return `
    <script>window.Shopify = { shop: 'scrapeverse-demo.myshopify.com', currency: 'INR' }; window.ShopifyAnalytics = { meta: { product: ${JSON.stringify(product)} } };</script>
    <script id="ProductJson-${escapeHtml(state.product_id)}" type="application/json">${JSON.stringify(product)}</script>
    <script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'Product',
      name: state.title,
      brand: { '@type': 'Brand', name: state.brand },
      category: state.category,
      image: product.featured_image,
      offers: { '@type': 'Offer', priceCurrency: state.currency, price: state.price, availability: 'https://schema.org/InStock', url: `${origin}${productPath(state)}` }
    })}</script>
    <main class="product-shell normal-product-layout" data-layout="normal">
      <div class="product-gallery"><img src="${product.featured_image}" alt="${escapeHtml(state.title)}"></div>
      <section class="product-copy">
        <p class="eyebrow">${escapeHtml(state.brand)}</p>
        <h1 class="product-title" data-product-title>${escapeHtml(state.title)}</h1>
        <p class="product-category">${escapeHtml(state.category)} · Limited demo collection</p>
        <div class="price-row">
          <span class="price" data-product-price>${money(state.price, state.currency)}</span>
          <del class="compare-at-price" data-compare-at>${money(state.compare_at_price, state.currency)}</del>
          <span class="sale-pill">${Math.round(((state.compare_at_price - state.price) / state.compare_at_price) * 100)}% OFF</span>
        </div>
        <p class="description">A controlled public product page for demonstrating ScrapeVerse verified data, price history, alerts, and self-healing extraction.</p>
        <form action="/cart/add" method="post" class="purchase-form"><input type="hidden" name="id" value="${escapeHtml(product.variants[0].id)}"><button type="submit">Add to cart</button></form>
        <p class="demo-note">Shopify-compatible demo storefront · Revision ${state.revision}</p>
      </section>
    </main>`;
}

function redesignedLayout(state, product, origin) {
  return `
    <script>window.Shopify = { shop: 'scrapeverse-demo.myshopify.com', currency: 'INR' }; window.ShopifyAnalytics = { meta: { product: ${JSON.stringify(product)} } };</script>
    <script id="ProductJson-${escapeHtml(state.product_id)}" type="application/json">${JSON.stringify(product)}</script>
    <script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'Product',
      name: state.title,
      sku: state.product_id,
      productID: state.product_id,
      brand: { '@type': 'Brand', name: state.brand },
      category: state.category,
      image: product.featured_image,
      offers: {
        '@type': 'Offer',
        priceCurrency: state.currency,
        price: state.price,
        availability: 'https://schema.org/InStock',
        url: `${origin}${productPath(state)}`
      }
    })}</script>
    <main class="redesigned-product-shell" data-layout="redesigned" itemscope itemtype="https://schema.org/Product">
      <div class="redesign-hero">
        <span class="redesign-kicker" itemprop="brand" itemscope itemtype="https://schema.org/Brand" data-brand-name="${escapeHtml(state.brand)}"><span itemprop="name">${escapeHtml(state.brand)}</span></span>
        <img class="redesign-product-art" itemprop="image" src="${escapeHtml(product.featured_image)}" alt="${escapeHtml(state.title)}" data-image-source="${escapeHtml(product.featured_image)}">
        <div class="redesign-heading-block">
          <h1 id="product-name-v2" class="headline-v2 redesign-name product-title" itemprop="name" data-catalog-title="${escapeHtml(state.title)}" data-product-name="${escapeHtml(state.title)}" data-product-title>${escapeHtml(state.title)}</h1>
        </div>
        <p class="redesign-category" itemprop="category" data-category-label="${escapeHtml(state.category)}">${escapeHtml(state.category)} · Limited demo collection</p>
        <p class="redesign-reference" data-product-id="${escapeHtml(state.product_id)}" data-product-reference="${escapeHtml(state.product_id)}">Product reference: <strong itemprop="sku">${escapeHtml(state.product_id)}</strong><meta itemprop="productID" content="${escapeHtml(state.product_id)}"></p>
        <p class="redesign-copy">The storefront received a small theme refresh: wrappers and IDs changed, but the product data contract remains stable.</p>
      </div>
      <div class="redesign-purchase-panel" itemprop="offers" itemscope itemtype="https://schema.org/Offer" data-item-key="${escapeHtml(state.product_id)}">
        <div id="purchase-summary-v2" class="purchase-summary">
          <meta itemprop="price" content="${escapeHtml(state.price)}">
          <meta itemprop="priceCurrency" content="${escapeHtml(state.currency)}">
          <span class="amount-v2 price" data-amount="${escapeHtml(state.price)}" data-currency-code="${escapeHtml(state.currency)}" data-product-price>${money(state.price, state.currency)}</span>
          <span class="was-v2 compare-at-price" data-previous-amount="${escapeHtml(state.compare_at_price)}" data-compare-at>Previously ${money(state.compare_at_price, state.currency)}</span>
        </div>
        <form action="/cart/add" method="post" class="purchase-form"><input type="hidden" name="id" value="${escapeHtml(product.variants[0].id)}"><button type="submit">Add to cart</button></form>
      </div>
      <p class="redesign-note">Shopify-compatible demo storefront · Revision ${state.revision}</p>
    </main>`;
}

export function renderProductPage(state, origin) {
  const product = buildProductJson(state, origin);
  const body = state.layout === 'redesigned'
    ? redesignedLayout(state, product, origin)
    : normalLayout(state, product, origin);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="description" content="ScrapeVerse controlled Shopify-compatible demo product">
    <link rel="preconnect" href="https://cdn.shopify.com/cdn/shop/">
    <link rel="stylesheet" href="/demo-store.css">
    <title>${escapeHtml(state.title)} · ScrapeVerse Demo Store</title>
  </head>
  <body>
    <div class="announcement">ScrapeVerse controlled demo store · <a href="/demo-control.html">Open demo controls</a></div>
    <header class="site-header"><a class="logo" href="/">S✦ Demo Goods</a><nav><a href="/">Home</a><a href="/products/demo-product">Collector baseline</a><a href="/products/demo-product-2">Self-healing target</a><a href="/demo-control.html">Demo controls</a></nav></header>
    <div class="storefront-marker" data-shopify-demo="true" data-demo-product="${escapeHtml(state.handle)}" data-demo-revision="${state.revision}"></div>
    ${body}
    <footer>Public Shopify-compatible demo page for ScrapeVerse · Current revision ${state.revision}</footer>
  </body>
</html>`;
}

export const htmlHeaders = state => ({
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store, no-cache, must-revalidate',
  'netlify-cdn-cache-control': 'no-store',
  'x-demo-product': state.handle,
  'x-demo-layout': state.layout,
  'x-demo-revision': String(state.revision)
});

export const jsonHeaders = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store, no-cache, must-revalidate',
  'netlify-cdn-cache-control': 'no-store'
};
