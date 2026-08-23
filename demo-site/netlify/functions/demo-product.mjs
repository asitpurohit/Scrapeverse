import { readDemoState } from '../../lib/demo-state.mjs';
import { htmlHeaders, renderProductPage } from '../../lib/demo-render.mjs';

export default async (request) => {
  try {
    const state = await readDemoState('demo-product');
    return new Response(renderProductPage(state, new URL(request.url).origin), {
      headers: htmlHeaders(state)
    });
  } catch (error) {
    console.error('[Demo Store] Baseline product render failed:', error);
    return new Response('Demo product is temporarily unavailable.', { status: 503 });
  }
};

export const config = { path: '/products/demo-product' };
