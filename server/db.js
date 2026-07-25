const { Pool } = require('pg')

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: Number(process.env.DB_POOL_SIZE || 12) })

async function query(text, params) { return pool.query(text, params) }
async function transaction(work) {
  const client = await pool.connect()
  try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result }
  catch (error) { await client.query('ROLLBACK'); throw error }
  finally { client.release() }
}
module.exports = { pool, query, transaction }
