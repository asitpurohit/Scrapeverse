// Background service worker
importScripts('backend-config.js');

// Prefer local development when it is healthy, but keep the live Render
// backend as the safe fallback when local is unavailable.
let activeBackendUrl = REMOTE_BACKEND_URL;
let backendResolution;

async function resolveBackendUrl() {
  if (!backendResolution) {
    backendResolution = (async () => {
      for (const candidate of [LOCAL_BACKEND_URL, REMOTE_BACKEND_URL]) {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 2500);
          const response = await fetch(`${candidate}${BACKEND_HEALTH_PATH}`, {
            cache: 'no-store',
            signal: controller.signal
          });
          clearTimeout(timeout);
          if (response.ok) {
            activeBackendUrl = candidate;
            return candidate;
          }
        } catch (error) {
          // Try the next backend.
        }
      }
      return activeBackendUrl;
    })();
  }
  return backendResolution;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'BACKEND_FETCH') {
    resolveBackendUrl().then((backendUrl) => {
      let targetUrl;
      try {
        targetUrl = new URL(message.path || '/', backendUrl);
        if (targetUrl.origin !== new URL(backendUrl).origin) {
          throw new Error('Backend relay only allows the resolved backend origin');
        }
      } catch (error) {
        sendResponse({ success: false, error: error.message });
        return;
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
    });

    return true;
  }

  if (message.type === 'GET_BACKEND_URL') {
    resolveBackendUrl().then((backendUrl) => sendResponse({ backendUrl }));
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
    resolveBackendUrl().then((backendUrl) => fetch(`${backendUrl}/api/detect-and-scrape`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain, url, pageType })
    })).then(res => res.json()).then(data => {
      chrome.storage.local.set({ lastScrapedData: data });
    }).catch(err => {
      console.log('Backend sync offline / waiting for start:', err.message);
    });

    sendResponse({ success: true });
  }
  return true;
});
