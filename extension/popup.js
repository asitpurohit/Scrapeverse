const BACKEND_URL = 'http://localhost:3001';

document.addEventListener('DOMContentLoaded', async () => {
  try {
    const res = await fetch(`${BACKEND_URL}/api/health-status`);
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
