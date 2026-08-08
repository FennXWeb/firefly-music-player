import nodemailer from 'nodemailer';
import twilio from 'twilio';

const smtp = process.env.SMTP_HOST && process.env.SMTP_USER
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 465),
      secure: String(process.env.SMTP_SECURE || 'true') === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
    })
  : null;

export async function sendAccountEmail({ to, code, type = 'sign-in' }) {
  if (!smtp) throw new Error('Email delivery is not configured.');
  const labels = { 'sign-in': 'sign-in', 'email-verification': 'verification', 'forget-password': 'password reset' };
  await smtp.sendMail({
    from: process.env.EMAIL_FROM || process.env.SMTP_USER,
    to,
    subject: `Your Firefly ${labels[type] || 'security'} code`,
    text: `Your Firefly code is ${code}. It expires in 10 minutes. If you did not request this code, you can ignore this message.`,
    html: `<div style="font-family:Segoe UI,Arial,sans-serif;background:#0b0b0b;color:#eee;padding:32px;border-radius:18px"><div style="color:#ff7057;font-size:12px;letter-spacing:.16em">FIREFLY</div><h1 style="font-size:24px">Your ${labels[type] || 'security'} code</h1><div style="font-size:34px;font-weight:750;letter-spacing:.22em;padding:20px 0">${code}</div><p style="color:#999">This code expires in 10 minutes. If you did not request it, you can ignore this message.</p></div>`
  });
}

export async function sendAccountSms({ to, code }) {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_FROM_NUMBER) throw new Error('SMS delivery is not configured.');
  const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  await client.messages.create({ from: process.env.TWILIO_FROM_NUMBER, to, body: `Your Firefly security code is ${code}. It expires in 10 minutes.` });
}
