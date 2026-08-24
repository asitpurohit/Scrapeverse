/*
 * Copy the existing local SQLite data into the Supabase PostgreSQL schema.
 *
 * Safe by default: run with --apply to write. Without --apply it only prints
 * row counts and performs no PostgreSQL writes.
 */
require('dotenv').config();

const { DatabaseSync } = require('node:sqlite');
const { Pool } = require('pg');
const path = require('path');

const TABLES = [
  'stores', 'products', 'price_history', 'reviews', 'review_summaries',
  'health_logs', 'collector_scrape_runs', 'watchlist', 'user_history',
  'traffic_events', 'user_tokens', 'user_purchases', 'brand_reputations',
  'push_subscriptions'
];

const BOOLEAN_COLUMNS = new Set([
  'products.is_verified_scrape',
  'watchlist.notified',
  'user_history.is_product_page'
]);

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function toPostgresValue(table, column, value) {
  if (value === undefined) return null;
  if (BOOLEAN_COLUMNS.has(`${table}.${column}`)) return Boolean(Number(value));
  return value;
}

function remapForeignKey(table, column, value, maps) {
  if (value === null || value === undefined) return value;
  if (table === 'products' && column === 'store_id') return maps.stores.get(String(value)) || null;
  if (['price_history', 'reviews', 'review_summaries', 'watchlist', 'user_history', 'user_purchases', 'push_subscriptions'].includes(table) && column === 'product_id') {
    return maps.products.get(String(value)) || null;
  }
  if (table === 'collector_scrape_runs' && column === 'store_id') return maps.stores.get(String(value)) || null;
  return value;
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');

  const sqlitePath = process.env.SQLITE_DB_PATH || path.join(__dirname, 'scrape_verse.db');
  const sqlite = new DatabaseSync(sqlitePath, { readOnly: true });
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 60000,
    ssl: { rejectUnauthorized: false }
  });

  try {
    const counts = {};
    for (const table of TABLES) {
      const row = sqlite.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`).get();
      counts[table] = Number(row.count) || 0;
    }
    console.log(JSON.stringify({ sqlitePath, sourceCounts: counts, apply: process.argv.includes('--apply') }, null, 2));
    if (!process.argv.includes('--apply')) {
      console.log('Dry run only. Re-run with --apply to copy these rows to Supabase.');
      return;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const maps = { stores: new Map(), products: new Map() };
      for (const table of TABLES) {
        const columns = sqlite.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all()
          .map(column => column.name);
        const rows = sqlite.prepare(`SELECT * FROM ${quoteIdentifier(table)}`).all();
        if (!rows.length) continue;

        const insertColumns = columns.filter(column => column !== 'id');
        const hasIdColumn = columns.includes('id');
        const columnSql = insertColumns.map(quoteIdentifier).join(', ');
        for (const row of rows) {
          const values = insertColumns.map(column => toPostgresValue(
            table,
            column,
            remapForeignKey(table, column, row[column], maps)
          ));
          const placeholders = values.map((_, index) => `$${index + 1}`).join(', ');
          let sql = `INSERT INTO public.${quoteIdentifier(table)} (${columnSql}) VALUES (${placeholders})`;
          if (table === 'stores') {
            sql += ' ON CONFLICT (domain, platform) DO UPDATE SET last_scraped_at = EXCLUDED.last_scraped_at';
          } else if (table === 'products') {
            sql += ' ON CONFLICT (url) DO UPDATE SET updated_at = EXCLUDED.updated_at';
          } else {
            sql += ' ON CONFLICT DO NOTHING';
          }
          if (hasIdColumn) sql += ' RETURNING id';
          const inserted = await client.query(sql, values);
          if (table === 'stores' && row.id !== undefined && inserted.rows[0]) {
            maps.stores.set(String(row.id), String(inserted.rows[0].id));
          }
          if (table === 'products' && row.id !== undefined && inserted.rows[0]) {
            maps.products.set(String(row.id), String(inserted.rows[0].id));
          }
        }
        console.log(`[Migration] ${table}: copied ${rows.length} row(s)`);
      }

      for (const table of TABLES) {
        if (table === 'user_tokens') continue;
        const sequence = await client.query(`SELECT pg_get_serial_sequence('public.${table}', 'id') AS sequence`);
        const sequenceName = sequence.rows[0]?.sequence;
        if (!sequenceName) continue;
        const max = await client.query(`SELECT MAX(id) AS max_id FROM public.${quoteIdentifier(table)}`);
        if (max.rows[0]?.max_id !== null) {
          await client.query('SELECT setval($1, $2, true)', [sequenceName, max.rows[0].max_id]);
        }
      }
      await client.query('COMMIT');
      console.log('[Migration] Completed successfully.');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } finally {
    sqlite.close();
    await pool.end();
  }
}

main().catch(error => {
  console.error(`[Migration] Failed: ${error.message}`);
  process.exit(1);
});
