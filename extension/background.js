// Background service worker
const BACKEND_URL = 'http://localhost:3001';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'BACKEND_FETCH') {
    let targetUrl;
    try {
      targetUrl = new URL(message.path || '/', BACKEND_URL);
      if (targetUrl.origin !== new URL(BACKEND_URL).origin) {
        throw new Error('Backend relay only allows the configured backend origin');
      }
    } catch (error) {
      sendResponse({ success: false, error: error.message });
      return false;
    }

    fetch(targetUrl.toString(), {
      method: message.init?.method || 'GET',
      headers: message.init?.headers || {},
      body: message.init?.body ?? undefined,
      cache: message.init?.cache || 'default'
    }).then(async (response) => {
      const body = await response.text();
      sendResponse({
        success: true,
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body
      });
    }).catch((error) => {
      sendResponse({ success: false, error: error.message || 'Backend request failed' });
    });

    return true;
  }

  if (message.type === 'SHOPIFY_DETECTED') {
    const { domain, url, pageType, meta } = message.payload;
    const tabId = sender.tab?.id;

    if (tabId) {
      // Set green badge icon
      chrome.action.setBadgeText({ text: 'ON', tabId });
      chrome.action.setBadgeBackgroundColor({ color: '#10B981', tabId });
    }

    // Save active store session to storage
    chrome.storage.local.set({
      currentStore: {
        domain,
        url,
        pageType,
        meta,
        detectedAt: Date.now()
      }
    });

    // Notify backend in background to warm cache
    fetch(`${BACKEND_URL}/api/detect-and-scrape`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain, url, pageType })
    }).then(res => res.json()).then(data => {
      chrome.storage.local.set({ lastScrapedData: data });
    }).catch(err => {
      console.log('Backend sync offline / waiting for start:', err.message);
    });

    sendResponse({ success: true });
  }
  return true;
});
