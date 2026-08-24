// Keep SQLite as the default until PostgreSQL mode has passed the complete
// local smoke test. This explicit switch prevents an accidentally present
// DATABASE_URL from changing the current application behavior.
const driver = String(process.env.DATABASE_DRIVER || 'sqlite').toLowerCase();

if (driver === 'postgres' || driver === 'postgresql') {
  module.exports = require('./db-postgres');
} else {
  module.exports = require('./db');
}
