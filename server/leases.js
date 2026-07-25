function codeFrom(text) { return String(text || '').match(/(?<!\d)\d{4,8}(?!\d)/)?.[0] || null }

async function releaseLease(client, lease, reason) {
  if (lease.status !== 'active') return
  const status = reason === 'expired' ? 'expired' : reason === 'insufficient_balance' ? 'insufficient_balance' : 'released'
  await client.query(`UPDATE leases SET status=$1,released_at=now(),release_reason=$2,updated_at=now(),reserved_cents=0 WHERE id=$3`, [status, reason, lease.id])
  if (lease.reserved_cents) await client.query('UPDATE users SET reserved_cents=GREATEST(0,reserved_cents-$1) WHERE id=$2', [lease.reserved_cents, lease.user_id])
  if (lease.resource_type === 'real') await client.query(`UPDATE real_mailboxes SET state='available',updated_at=now() WHERE id=$1 AND state='leased'`, [lease.real_mailbox_id])
}
module.exports = { codeFrom, releaseLease }
