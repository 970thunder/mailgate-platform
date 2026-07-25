const nodemailer = require('nodemailer')

async function sendAuthEmail(to, purpose, token) {
  const link = `${process.env.APP_ORIGIN || 'http://localhost:3001'}/?${purpose === 'verify_email' ? 'verify' : 'reset'}=${encodeURIComponent(token)}`
  if (!process.env.SMTP_HOST) {
    console.warn(`[MailGate] SMTP is not configured; ${purpose} link was not delivered to ${to}`)
    return { delivered: false, link }
  }
  const transport = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), secure: process.env.SMTP_SECURE === 'true', auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } })
  const title = purpose === 'verify_email' ? '验证你的 MailGate 邮箱' : '重置你的 MailGate 密码'
  await transport.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject: title, text: `${title}：${link}\n此链接 30 分钟内有效。` })
  return { delivered: true }
}
async function sendInviteEmail(to, token) {
  const link = `${process.env.APP_ORIGIN || 'http://localhost:3001'}/?invite=${encodeURIComponent(token)}`
  if (!process.env.SMTP_HOST) { console.warn(`[MailGate] SMTP is not configured; invite link was not delivered to ${to}`); return { delivered: false, link } }
  const transport = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), secure: process.env.SMTP_SECURE === 'true', auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } })
  await transport.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject: '邀请加入 MailGate', text: `请通过此链接创建账户：${link}\n此链接 72 小时内有效。` })
  return { delivered: true }
}
module.exports = { sendAuthEmail, sendInviteEmail }
