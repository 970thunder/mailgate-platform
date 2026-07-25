const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')
const { codeFrom } = require('../server/leases')

test('extracts a standalone 4-8 digit verification code', () => {
  assert.equal(codeFrom('Your code is 483920. Do not share it.'), '483920')
  assert.equal(codeFrom('Reference #123456789 should be ignored; code 7744'), '7744')
  assert.equal(codeFrom('no verification token'), null)
})

test('payment signature accepts only the exact HMAC payload', () => {
  process.env.PAYMENT_WEBHOOK_SECRET = 'test-payment-secret'
  delete require.cache[require.resolve('../server/security')]
  const { verifyPaymentSignature } = require('../server/security')
  const body = '{"eventId":"abc12345"}'
  const signature = crypto.createHmac('sha256', process.env.PAYMENT_WEBHOOK_SECRET).update(body).digest('hex')
  assert.equal(verifyPaymentSignature(body, signature), true)
  assert.equal(verifyPaymentSignature(body, 'x'), false)
  assert.equal(verifyPaymentSignature(`${body}x`, signature), false)
})
