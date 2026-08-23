import { getStore } from '@netlify/blobs';

const STORE_NAME = 'scrapeverse-demo-store';
const STATE_KEY = 'demo-product-state';

export const DEMO_PRODUCT_HANDLES = Object.freeze([
  'demo-product',
  'demo-product-2'
]);

const DEFAULT_PRODUCTS = {
  'demo-product': {
    product_id: 'scrapeverse-demo-001',
    title: 'Aurora Stone Pendant',
    price: 2499,
    compare_at_price: 3499,
    currency: 'INR',
    brand: 'ScrapeVerse Demo Store',
    category: 'Jewelry',
    layout: 'normal',
    revision: 1,
    updated_at: null
  },
  'demo-product-2': {
    product_id: 'scrapeverse-demo-002',
    title: 'Moonlit River Ring',
    price: 1899,
    compare_at_price: 2899,
    currency: 'INR',
    brand: 'ScrapeVerse Demo Store',
    category: 'Jewelry',
    layout: 'normal',
    revision: 1,
    updated_at: null
  }
};

export const DEFAULT_DEMO_STATE = Object.freeze({
  product_id: DEFAULT_PRODUCTS['demo-product'].product_id,
  title: DEFAULT_PRODUCTS['demo-product'].title,
  price: DEFAULT_PRODUCTS['demo-product'].price,
  compare_at_price: DEFAULT_PRODUCTS['demo-product'].compare_at_price,
  currency: DEFAULT_PRODUCTS['demo-product'].currency,
  brand: DEFAULT_PRODUCTS['demo-product'].brand,
  category: DEFAULT_PRODUCTS['demo-product'].category,
  layout: DEFAULT_PRODUCTS['demo-product'].layout,
  revision: DEFAULT_PRODUCTS['demo-product'].revision,
  updated_at: DEFAULT_PRODUCTS['demo-product'].updated_at
});

function toPositiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : fallback;
}

function defaultProduct(handle) {
  return DEFAULT_PRODUCTS[handle] || DEFAULT_PRODUCTS['demo-product'];
}

export function normalizeHandle(handle = 'demo-product') {
  const normalized = String(handle || '').trim().toLowerCase();
  if (!DEMO_PRODUCT_HANDLES.includes(normalized)) {
    throw new Error(`Unsupported demo product handle: ${handle}`);
  }
  return normalized;
}

export function normalizeDemoState(value = {}, handle = 'demo-product') {
  const productHandle = normalizeHandle(handle);
  const fallback = defaultProduct(productHandle);
  const current = { ...fallback, ...(value || {}) };
  const nextPrice = toPositiveNumber(current.price, fallback.price);
  const nextCompare = toPositiveNumber(current.compare_at_price, fallback.compare_at_price);
  const title = String(current.title || fallback.title).trim().slice(0, 120);

  return {
    ...fallback,
    ...current,
    handle: productHandle,
    title: title || fallback.title,
    price: nextPrice,
    compare_at_price: Math.max(nextCompare, nextPrice),
    layout: current.layout === 'redesigned' ? 'redesigned' : 'normal',
    revision: Math.max(1, Number(current.revision) || 1),
    updated_at: current.updated_at || null
  };
}

export function normalizeDemoStoreState(value = {}) {
  // Keep the first version of the Blob readable if it was created before the
  // two-product demo was introduced.
  const storedProducts = value?.products && typeof value.products === 'object'
    ? value.products
    : { 'demo-product': value };

  return {
    version: 2,
    revision: Math.max(1, Number(value?.revision) || 1),
    updated_at: value?.updated_at || null,
    products: Object.fromEntries(
      DEMO_PRODUCT_HANDLES.map(handle => [
        handle,
        normalizeDemoState(storedProducts[handle], handle)
      ])
    )
  };
}

function getDemoStore() {
  return getStore(STORE_NAME, { consistency: 'strong' });
}

export async function readDemoStoreState() {
  const stored = await getDemoStore().get(STATE_KEY, {
    type: 'json',
    consistency: 'strong'
  });
  return normalizeDemoStoreState(stored || {});
}

export async function readDemoState(handle = 'demo-product') {
  const productHandle = normalizeHandle(handle);
  const storeState = await readDemoStoreState();
  return storeState.products[productHandle];
}

export async function writeDemoState(handle = 'demo-product', patch = {}) {
  const productHandle = normalizeHandle(handle);
  const currentStore = await readDemoStoreState();
  const currentProduct = currentStore.products[productHandle];
  const nextProduct = normalizeDemoState({
    ...currentProduct,
    ...patch,
    revision: currentProduct.revision + 1,
    updated_at: new Date().toISOString()
  }, productHandle);
  const nextStore = {
    ...currentStore,
    revision: currentStore.revision + 1,
    updated_at: nextProduct.updated_at,
    products: {
      ...currentStore.products,
      [productHandle]: nextProduct
    }
  };

  await getDemoStore().setJSON(STATE_KEY, nextStore);
  return nextProduct;
}
