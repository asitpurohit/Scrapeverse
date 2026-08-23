document.addEventListener('DOMContentLoaded', async () => {
  try {
    const backendUrl = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'GET_BACKEND_URL' }, (result) => {
        if (chrome.runtime.lastError || !result?.backendUrl) {
          reject(new Error(chrome.runtime.lastError?.message || 'Backend unavailable'));
          return;
        }
        resolve(result.backendUrl);
      });
    });
    const dashboardLink = document.getElementById('dashboardLink');
    if (dashboardLink) dashboardLink.href = `${backendUrl}/admin`;
    const res = await fetch(`${backendUrl}/api/health-status`);
    const data = await res.json();
    if (data.success) {
      const badge = document.getElementById('popupHealthBadge');
      const msg = document.getElementById('selfHealMsg');
      if (badge) badge.innerText = data.badgeText;
      if (msg) msg.innerText = data.message;
    }
  } catch (e) {
    const badge = document.getElementById('popupHealthBadge');
    if (badge) badge.innerText = 'Local Server Offline';
  }
});
