import { readDemoState } from '../../lib/demo-state.mjs';
import { buildProductJson, jsonHeaders } from '../../lib/demo-render.mjs';

export default async (request) => {
  try {
    const state = await readDemoState('demo-product');
    const product = buildProductJson(state, new URL(request.url).origin);
    return new Response(JSON.stringify({ product }), { headers: jsonHeaders });
  } catch (error) {
    console.error('[Demo Store] Baseline product JSON failed:', error);
    return new Response(JSON.stringify({ error: 'Demo product JSON is temporarily unavailable.' }), {
      status: 503,
      headers: jsonHeaders
    });
  }
};

export const config = { path: '/products/demo-product.json' };
