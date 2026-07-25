const { pool } = require('./db')
const bcrypt = require('bcryptjs')

const sql = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text NOT NULL, password_hash text NOT NULL, role text NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')), status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')), balance_cents integer NOT NULL DEFAULT 0, reserved_cents integer NOT NULL DEFAULT 0, email_verified_at timestamptz, totp_secret_encrypted text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz, deleted_by uuid
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS reserved_cents integer NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_pending_secret_encrypted text;
CREATE UNIQUE INDEX IF NOT EXISTS users_email_active_idx ON users (lower(email)) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id), refresh_hash text NOT NULL UNIQUE, expires_at timestamptz NOT NULL, revoked_at timestamptz, ip inet, user_agent text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS auth_tokens (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id), purpose text NOT NULL CHECK (purpose IN ('verify_email','reset_password')), token_hash text NOT NULL UNIQUE, expires_at timestamptz NOT NULL, used_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS invitations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text NOT NULL, role text NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')), token_hash text NOT NULL UNIQUE, expires_at timestamptz NOT NULL, accepted_at timestamptz, created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz, deleted_by uuid);
CREATE UNIQUE INDEX IF NOT EXISTS invitations_email_active_idx ON invitations (lower(email)) WHERE accepted_at IS NULL AND deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS domains (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, code_price_cents integer NOT NULL CHECK (code_price_cents >= 0), default_ttl_minutes integer NOT NULL DEFAULT 30 CHECK (default_ttl_minutes BETWEEN 1 AND 1440), enabled boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz, deleted_by uuid);
ALTER TABLE domains ADD COLUMN IF NOT EXISTS max_active_leases integer NOT NULL DEFAULT 0 CHECK (max_active_leases >= 0);
CREATE UNIQUE INDEX IF NOT EXISTS domains_name_active_idx ON domains (lower(name)) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS mail_sources (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, protocol text NOT NULL CHECK (protocol IN ('imap','api')), config_encrypted text NOT NULL, enabled boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz, deleted_by uuid);
CREATE TABLE IF NOT EXISTS real_mailboxes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_id uuid NOT NULL REFERENCES mail_sources(id), address text NOT NULL, external_ref text, hourly_price_cents integer NOT NULL CHECK (hourly_price_cents >= 0), state text NOT NULL DEFAULT 'available' CHECK (state IN ('available','leased','disabled')), last_polled_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz, deleted_by uuid);
CREATE UNIQUE INDEX IF NOT EXISTS real_mailboxes_address_active_idx ON real_mailboxes (lower(address)) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS leases (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id), resource_type text NOT NULL CHECK (resource_type IN ('domain','real')), domain_id uuid REFERENCES domains(id), real_mailbox_id uuid REFERENCES real_mailboxes(id), address text NOT NULL, status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','released','expired','insufficient_balance')), code_charged_at timestamptz, free_until timestamptz, next_bill_at timestamptz, reserved_cents integer NOT NULL DEFAULT 0, expires_at timestamptz NOT NULL, released_at timestamptz, release_reason text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz, deleted_by uuid, CHECK ((resource_type='domain' AND domain_id IS NOT NULL AND real_mailbox_id IS NULL) OR (resource_type='real' AND real_mailbox_id IS NOT NULL AND domain_id IS NULL)));
CREATE INDEX IF NOT EXISTS leases_user_active_idx ON leases (user_id, created_at DESC) WHERE deleted_at IS NULL;
ALTER TABLE leases ADD COLUMN IF NOT EXISTS reserved_cents integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS leases_maintenance_idx ON leases (status, expires_at, next_bill_at) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS inbound_messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), lease_id uuid NOT NULL REFERENCES leases(id), event_id text NOT NULL UNIQUE, sender text, subject text, body text, verification_code text, received_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz, deleted_by uuid);
CREATE INDEX IF NOT EXISTS inbound_messages_lease_idx ON inbound_messages (lease_id, received_at DESC) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS wallet_transactions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id), type text NOT NULL CHECK (type IN ('code_charge','real_hour_charge','recharge','refund','reservation')), amount_cents integer NOT NULL, balance_after_cents integer NOT NULL, lease_id uuid REFERENCES leases(id), payment_order_id uuid, idempotency_key text UNIQUE, note text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE wallet_transactions DROP CONSTRAINT IF EXISTS wallet_transactions_type_check;
ALTER TABLE wallet_transactions ADD CONSTRAINT wallet_transactions_type_check CHECK (type IN ('code_charge','real_hour_charge','recharge','refund','reservation','manual_adjustment'));
CREATE TABLE IF NOT EXISTS payment_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_no text NOT NULL UNIQUE, user_id uuid NOT NULL REFERENCES users(id), amount_cents integer NOT NULL CHECK (amount_cents > 0), status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','cancelled','expired')), provider text NOT NULL DEFAULT 'hyper99', provider_order_no text, paid_at timestamptz, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz, deleted_by uuid);
DO $$ BEGIN ALTER TABLE wallet_transactions ADD CONSTRAINT wallet_transactions_order_fk FOREIGN KEY (payment_order_id) REFERENCES payment_orders(id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE IF NOT EXISTS payment_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_id text NOT NULL UNIQUE, order_no text, signature_valid boolean NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS redeem_cards (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code_hash text NOT NULL UNIQUE, code_prefix text NOT NULL, code_suffix text NOT NULL, amount_cents integer NOT NULL CHECK (amount_cents > 0), status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','redeemed','disabled')), expires_at timestamptz, redeemed_by uuid REFERENCES users(id), redeemed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz, deleted_by uuid);
ALTER TABLE redeem_cards ADD COLUMN IF NOT EXISTS batch_id uuid;
CREATE TABLE IF NOT EXISTS redeem_card_batches (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), amount_cents integer NOT NULL, quantity integer NOT NULL, expires_at timestamptz, created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz, deleted_by uuid);
DO $$ BEGIN ALTER TABLE redeem_cards ADD CONSTRAINT redeem_cards_batch_fk FOREIGN KEY (batch_id) REFERENCES redeem_card_batches(id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS redeem_cards_status_idx ON redeem_cards (status, created_at DESC) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS audit_logs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_user_id uuid REFERENCES users(id), actor_label text NOT NULL, action text NOT NULL, entity_type text, entity_id uuid, detail jsonb NOT NULL DEFAULT '{}', ip inet, created_at timestamptz NOT NULL DEFAULT now());
`

async function migrate() {
  const client = await pool.connect()
  try {
    await client.query('BEGIN'); await client.query(sql)
    const email = (process.env.ADMIN_EMAIL || 'admin@example.com').toLowerCase()
    const count = await client.query('SELECT 1 FROM users WHERE lower(email)=$1 AND deleted_at IS NULL', [email])
    if (!count.rowCount) await client.query('INSERT INTO users (email,password_hash,role,email_verified_at,balance_cents) VALUES ($1,$2,$3,now(),$4)', [email, await bcrypt.hash(process.env.ADMIN_PASSWORD || 'ChangeMe123!', 12), 'admin', 0])
    await client.query('COMMIT'); console.log('Database migration completed')
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release(); await pool.end() }
}
migrate().catch(error => { console.error(error); process.exit(1) })
