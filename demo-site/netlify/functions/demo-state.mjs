import { readDemoState, writeDemoState, normalizeHandle } from '../../lib/demo-state.mjs';

const jsonHeaders = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store, no-cache, must-revalidate',
  'netlify-cdn-cache-control': 'no-store'
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: jsonHeaders
  });
}

export default async (request) => {
  if (request.method === 'GET') {
    try {
      const handle = new URL(request.url).searchParams.get('handle') || 'demo-product';
      return json({ success: true, state: await readDemoState(handle) });
    } catch (error) {
      console.error('[Demo Store] State read failed:', error);
      return json({ success: false, error: 'Demo state is not available.' }, 503);
    }
  }

  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed.' }, 405);
  }

  try {
    const body = await request.json();
    const handle = normalizeHandle(body.handle || 'demo-product');
    const patch = {};
    if (body.title !== undefined) patch.title = body.title;
    if (body.price !== undefined) patch.price = body.price;
    if (body.compare_at_price !== undefined) patch.compare_at_price = body.compare_at_price;
    if (body.layout !== undefined) patch.layout = body.layout;

    const state = await writeDemoState(handle, patch);
    console.log('[Demo Store] State updated:', JSON.stringify({
      handle: state.handle,
      revision: state.revision,
      price: state.price,
      compare_at_price: state.compare_at_price,
      layout: state.layout
    }));
    return json({ success: true, state });
  } catch (error) {
    console.error('[Demo Store] State update failed:', error);
    return json({ success: false, error: 'Demo state could not be updated.' }, 400);
  }
};

export const config = { path: '/api/demo-state' };
