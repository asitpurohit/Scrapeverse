const { Pool } = require('pg');

let pool;

function getPool() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required for the PostgreSQL database adapter');
  }

  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      // Keep the default small for Supabase pooler/free-tier limits. Render
      // can raise this explicitly with PG_POOL_MAX after observing traffic.
      max: Number(process.env.PG_POOL_MAX) || 2,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      // Supabase pooler connections use TLS in production.
      ssl: process.env.NODE_ENV === 'production'
        ? { rejectUnauthorized: false }
        : { rejectUnauthorized: false }
    });

    pool.on('error', (error) => {
      console.error('[PostgreSQL] Unexpected idle client error:', error.message);
    });
  }

  return pool;
}

function isTransientConnectionError(error) {
  const message = String(error?.message || error || '');
  return /timeout|connection terminated|connection refused|ECONNRESET|EPIPE|ENETUNREACH/i.test(message);
}

async function query(text, values = []) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await getPool().query(text, values);
    } catch (error) {
      lastError = error;
      if (!isTransientConnectionError(error) || attempt === 1) throw error;
      // Drop stale pool clients before the one retry. This is especially
      // useful when Supavisor briefly closes an idle connection.
      await close();
      await new Promise(resolve => setTimeout(resolve, 350));
    }
  }
  throw lastError;
}

async function withTransaction(callback) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (rollbackError) {}
    throw error;
  } finally {
    client.release();
  }
}

async function close() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = { getPool, query, withTransaction, close };
