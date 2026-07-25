const crypto = require('crypto')
const jwt = require('jsonwebtoken')
const speakeasy = require('speakeasy')

const key = () => Buffer.from(process.env.ENCRYPTION_KEY || '', 'hex')
function requireEnv(name) { if (!process.env[name] && process.env.NODE_ENV === 'production') throw new Error(`${name} is required in production`) }
function encrypt(value) {
  const encryptionKey = key(); if (encryptionKey.length !== 32) throw new Error('ENCRYPTION_KEY must be 64 hex characters')
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv)
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`
}
function decrypt(value) {
  const encryptionKey = key(); const [ivText, tagText, payload] = value.split('.')
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(ivText, 'base64url'))
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'))
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(payload, 'base64url')), decipher.final()]).toString('utf8'))
}
function tokenHash(token) { return crypto.createHash('sha256').update(token).digest('hex') }
function randomToken(bytes = 32) { return crypto.randomBytes(bytes).toString('base64url') }
function signAccessToken(userId, sessionId) { return jwt.sign({ sub: userId, sid: sessionId }, process.env.JWT_SECRET, { expiresIn: '15m', issuer: 'mailgate' }) }
function verifyAccessToken(token) { return jwt.verify(token, process.env.JWT_SECRET, { issuer: 'mailgate' }) }
function verifyPaymentSignature(rawBody, signature) { const expected = crypto.createHmac('sha256', process.env.PAYMENT_WEBHOOK_SECRET || '').update(rawBody).digest('hex'); if (!signature || signature.length !== expected.length) return false; return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature)) }
function verifyTotp(secret, code) { return speakeasy.totp.verify({ secret, encoding: 'base32', token: code, window: 1 }) }
function maskEmail(value) { const [local, domain] = value.split('@'); return `${local.slice(0, 2)}***@${domain}` }
module.exports = { decrypt, encrypt, maskEmail, randomToken, requireEnv, signAccessToken, tokenHash, verifyAccessToken, verifyPaymentSignature, verifyTotp }
