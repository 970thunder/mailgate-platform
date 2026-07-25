const fs = require('fs')
const path = require('path')
const bcrypt = require('bcryptjs')
const { transaction, pool } = require('./db')

async function importLegacy() {
  const file = path.join(process.cwd(), 'data', 'store.json')
  if (!fs.existsSync(file)) throw new Error(`Legacy data not found: ${file}`)
  const legacy = JSON.parse(fs.readFileSync(file, 'utf8'))
  await transaction(async client => {
    const users = new Map()
    for (const user of legacy.users || []) {
      const hash = user.passwordHash || await bcrypt.hash('ResetMe123!', 12)
      const result = await client.query(`INSERT INTO users (email,password_hash,role,balance_cents,email_verified_at,created_at) VALUES (lower($1),$2,$3,$4,now(),$5) ON CONFLICT (lower(email)) WHERE deleted_at IS NULL DO UPDATE SET balance_cents=EXCLUDED.balance_cents RETURNING id,email`, [user.email,hash,user.role === 'admin' ? 'admin' : 'user',Math.round(Number(user.balance || 0) * 100),user.createdAt || new Date().toISOString()])
      users.set(user.id, result.rows[0].id)
    }
    const domains = new Map()
    for (const domain of legacy.domains || []) {
      const result = await client.query(`INSERT INTO domains (name,code_price_cents,enabled) VALUES (lower($1),$2,$3) ON CONFLICT (lower(name)) WHERE deleted_at IS NULL DO UPDATE SET code_price_cents=EXCLUDED.code_price_cents,enabled=EXCLUDED.enabled RETURNING id,name`, [domain.name,Math.round(Number(domain.price || 0) * 100),domain.enabled !== false])
      domains.set(domain.id, result.rows[0].id)
    }
    for (const mailbox of legacy.mailboxes || []) {
      if (!users.has(mailbox.userId) || !domains.has(mailbox.domainId)) continue
      await client.query(`INSERT INTO leases (user_id,resource_type,domain_id,address,status,expires_at,created_at,code_charged_at) VALUES ($1,'domain',$2,$3,$4,now(),$5,$6) ON CONFLICT DO NOTHING`, [users.get(mailbox.userId),domains.get(mailbox.domainId),mailbox.address,'expired',mailbox.createdAt || new Date().toISOString(),mailbox.lastCode ? new Date().toISOString() : null])
    }
  })
  console.log('Legacy JSON import completed')
}
importLegacy().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => pool.end())
