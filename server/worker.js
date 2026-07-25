const { Worker } = require('bullmq')
const { ImapFlow } = require('imapflow')
const { query, transaction, pool } = require('./db')
const { decrypt } = require('./security')
const { codeFrom, releaseLease } = require('./leases')

const connection = { url: process.env.REDIS_URL || 'redis://127.0.0.1:6379', maxRetriesPerRequest: null }

async function recordInbound(event) {
  return transaction(async client => {
    const existing = await client.query('SELECT id FROM inbound_messages WHERE event_id=$1', [event.eventId])
    if (existing.rowCount) return { duplicate: true }
    const leaseResult = await client.query(`SELECT l.*,d.code_price_cents,rm.hourly_price_cents FROM leases l LEFT JOIN domains d ON d.id=l.domain_id LEFT JOIN real_mailboxes rm ON rm.id=l.real_mailbox_id WHERE lower(l.address)=lower($1) AND l.status='active' AND l.deleted_at IS NULL AND l.expires_at>now() FOR UPDATE OF l`, [event.to])
    const lease = leaseResult.rows[0]
    if (!lease) return { ignored: true }
    const receivedAt = event.receivedAt || new Date().toISOString(), code = codeFrom(event.text)
    const message = await client.query(`INSERT INTO inbound_messages (lease_id,event_id,sender,subject,body,verification_code,received_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [lease.id,event.eventId,event.from || null,event.subject || null,event.text || null,code,receivedAt])
    if (lease.resource_type === 'domain' && code && !lease.code_charged_at) {
      const user = (await client.query('SELECT * FROM users WHERE id=$1 FOR UPDATE', [lease.user_id])).rows[0]
      const amount = lease.code_price_cents
      if (user.balance_cents - user.reserved_cents >= amount) {
        const balance = user.balance_cents - amount
        await client.query('UPDATE users SET balance_cents=$1,updated_at=now() WHERE id=$2', [balance, user.id])
        await client.query('UPDATE leases SET code_charged_at=now(),updated_at=now() WHERE id=$1', [lease.id])
        await client.query(`INSERT INTO wallet_transactions (user_id,type,amount_cents,balance_after_cents,lease_id,idempotency_key,note) VALUES ($1,'code_charge',$2,$3,$4,$5,$6)`, [user.id,-amount,balance,lease.id,`code:${lease.id}`,`域名邮箱成功接码 ${lease.address}`])
      } else {
        await releaseLease(client, lease, 'insufficient_balance')
      }
    }
    return { messageId: message.rows[0].id, code }
  })
}

async function billRealLeases() {
  await transaction(async client => {
    const due = await client.query(`SELECT l.*,rm.hourly_price_cents FROM leases l JOIN real_mailboxes rm ON rm.id=l.real_mailbox_id WHERE l.resource_type='real' AND l.status='active' AND l.deleted_at IS NULL AND l.expires_at>now() AND l.next_bill_at<=now() FOR UPDATE SKIP LOCKED`)
    for (const lease of due.rows) {
      const user = (await client.query('SELECT * FROM users WHERE id=$1 FOR UPDATE', [lease.user_id])).rows[0]
      const amount = lease.hourly_price_cents
      if (user.balance_cents < amount) { await releaseLease(client, lease, 'insufficient_balance'); continue }
      const balance = user.balance_cents - amount
      const reservation = Math.min(lease.reserved_cents, amount)
      await client.query('UPDATE users SET balance_cents=$1,reserved_cents=GREATEST(0,reserved_cents-$2),updated_at=now() WHERE id=$3', [balance,reservation,user.id])
      await client.query(`UPDATE leases SET reserved_cents=GREATEST(0,reserved_cents-$1),next_bill_at=now()+interval '1 hour',updated_at=now() WHERE id=$2`, [reservation,lease.id])
      await client.query(`INSERT INTO wallet_transactions (user_id,type,amount_cents,balance_after_cents,lease_id,idempotency_key,note) VALUES ($1,'real_hour_charge',$2,$3,$4,$5,$6)`, [user.id,-amount,balance,lease.id,`real:${lease.id}:${lease.next_bill_at.toISOString()}`,`真实邮箱租用小时费用 ${lease.address}`])
    }
  })
}

async function expireLeases() {
  await transaction(async client => {
    const expired = await client.query(`SELECT * FROM leases WHERE status='active' AND deleted_at IS NULL AND expires_at<=now() FOR UPDATE SKIP LOCKED`)
    for (const lease of expired.rows) await releaseLease(client, lease, 'expired')
  })
}

async function purgeExpiredData() {
  await transaction(async client => {
    await client.query(`DELETE FROM inbound_messages WHERE received_at < now() - interval '30 days'`)
    await client.query(`DELETE FROM inbound_messages WHERE deleted_at < now() - interval '90 days'`)
    await client.query(`DELETE FROM payment_orders p WHERE deleted_at < now() - interval '90 days' AND NOT EXISTS (SELECT 1 FROM wallet_transactions w WHERE w.payment_order_id=p.id)`)
    await client.query(`DELETE FROM leases l WHERE deleted_at < now() - interval '90 days' AND NOT EXISTS (SELECT 1 FROM wallet_transactions w WHERE w.lease_id=l.id) AND NOT EXISTS (SELECT 1 FROM inbound_messages m WHERE m.lease_id=l.id)`)
    await client.query(`DELETE FROM real_mailboxes r WHERE deleted_at < now() - interval '90 days' AND NOT EXISTS (SELECT 1 FROM leases l WHERE l.real_mailbox_id=r.id)`)
    await client.query(`DELETE FROM domains d WHERE deleted_at < now() - interval '90 days' AND NOT EXISTS (SELECT 1 FROM leases l WHERE l.domain_id=d.id)`)
    await client.query(`DELETE FROM mail_sources s WHERE deleted_at < now() - interval '90 days' AND NOT EXISTS (SELECT 1 FROM real_mailboxes r WHERE r.source_id=s.id)`)
    await client.query(`DELETE FROM auth_tokens WHERE expires_at < now() - interval '1 day'`)
    await client.query(`DELETE FROM sessions WHERE expires_at < now() - interval '1 day'`)
  })
}

async function pollImapSources() {
  const sources = await query(`SELECT * FROM mail_sources WHERE protocol='imap' AND enabled=true AND deleted_at IS NULL`)
  for (const source of sources.rows) {
    try {
      const config = decrypt(source.config_encrypted)
      const client = new ImapFlow({ host: config.host, port: config.port || 993, secure: config.secure !== false, auth: { user: config.username, pass: config.password }, logger: false })
      await client.connect(); const lock = await client.getMailboxLock(config.mailbox || 'INBOX')
      try {
        const messages = await client.search({ seen: false }, { uid: true })
        for (const uid of messages.slice(-100)) {
          const mail = await client.fetchOne(uid, { envelope: true, source: true, internalDate: true })
          const to = (mail.envelope.to || []).map(x => x.address).filter(Boolean)
          for (const address of to) await recordInbound({ eventId: `imap:${source.id}:${uid}:${address}`,to:address,from:mail.envelope.from?.[0]?.address,subject:mail.envelope.subject,text:mail.source.toString('utf8'),receivedAt:mail.internalDate.toISOString() })
          await client.messageFlagsAdd(uid, ['\\Seen'])
        }
      } finally { lock.release(); await client.logout() }
      await query('UPDATE real_mailboxes SET last_polled_at=now() WHERE source_id=$1 AND deleted_at IS NULL', [source.id])
    } catch (error) { console.error(`IMAP poll failed for ${source.name}:`, error.message) }
  }
}

const inboundWorker = new Worker('inbound-mail', job => recordInbound(job.data), { connection, concurrency: 12 })
inboundWorker.on('failed', (job, error) => console.error(`Inbound job ${job?.id} failed:`, error.message))
setInterval(() => expireLeases().catch(console.error), 30_000)
setInterval(() => billRealLeases().catch(console.error), 30_000)
setInterval(() => pollImapSources().catch(console.error), 60_000)
setInterval(() => purgeExpiredData().catch(console.error), 24 * 60 * 60 * 1000)
Promise.all([expireLeases(), billRealLeases(), pollImapSources(), purgeExpiredData()]).catch(console.error)
console.log('MailGate worker started')
process.on('SIGTERM', async () => { await inboundWorker.close(); await pool.end(); process.exit(0) })
module.exports = { billRealLeases, expireLeases, recordInbound }
