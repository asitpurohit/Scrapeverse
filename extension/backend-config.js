// Keep local development fast and offline-friendly, with Render as the
// production fallback when the local backend is not running.
const LOCAL_BACKEND_URL = 'http://localhost:3001';
const REMOTE_BACKEND_URL = 'https://scrapeverse.onrender.com';
const BACKEND_HEALTH_PATH = '/api/health-status';
