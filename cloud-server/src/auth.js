import 'dotenv/config';
import crypto from 'node:crypto';
import { Pool } from 'pg';
import { betterAuth } from 'better-auth';
import { emailOTP, phoneNumber } from 'better-auth/plugins';
import { passkey } from '@better-auth/passkey';
import { sendAccountEmail, sendAccountSms } from './messaging.js';

export const publicURL = String(process.env.PUBLIC_URL || 'http://localhost:3000').replace(/\/$/, '');
const rpID = new URL(publicURL).hostname;

const connectionString = String(process.env.DATABASE_URL || '').trim();
if (!connectionString) throw new Error('DATABASE_URL must contain the PostgreSQL connection string.');
const databaseSSL = String(process.env.DATABASE_SSL || 'true').toLowerCase() !== 'false';

export const pool = new Pool({
  connectionString,
  max: Math.max(1, Number(process.env.DATABASE_POOL_SIZE) || 10),
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 30_000,
  ssl: databaseSSL ? { rejectUnauthorized: String(process.env.DATABASE_SSL_REJECT_UNAUTHORIZED || 'true').toLowerCase() !== 'false' } : false
});

export const auth = betterAuth({
  appName: 'Ignifire',
  baseURL: publicURL,
  secret: process.env.BETTER_AUTH_SECRET,
  database: pool,
  trustedOrigins: [publicURL],
  emailAndPassword: { enabled: true, minPasswordLength: 10, requireEmailVerification: true },
  verification: { storeIdentifier: 'hashed' },
  session: { expiresIn: 60 * 60 * 24 * 30, updateAge: 60 * 60 * 24 },
  rateLimit: {
    enabled: true,
    storage: 'database',
    window: 60,
    max: 120,
    customRules: {
      '/email-otp/send-verification-otp': { window: 60, max: 5 },
      '/phone-number/send-otp': { window: 60, max: 5 },
      '/sign-in/email': { window: 60, max: 10 },
      '/sign-in/phone-number': { window: 60, max: 10 }
    }
  },
  plugins: [
    emailOTP({
      otpLength: 6,
      expiresIn: 600,
      allowedAttempts: 5,
      storeOTP: 'hashed',
      overrideDefaultEmailVerification: true,
      sendVerificationOnSignUp: true,
      sendVerificationOTP({ email, otp, type }) { void sendAccountEmail({ to: email, code: otp, type }).catch(error => console.error('Email delivery failed:', error.message)); }
    }),
    phoneNumber({
      otpLength: 6,
      expiresIn: 600,
      allowedAttempts: 5,
      requireVerification: true,
      phoneNumberValidator(number) { return /^\+[1-9]\d{7,14}$/.test(number); },
      sendOTP({ phoneNumber: destination, code }) { void sendAccountSms({ to: destination, code }).catch(error => console.error('SMS delivery failed:', error.message)); },
      sendPasswordResetOTP({ phoneNumber: destination, code }) { void sendAccountSms({ to: destination, code }).catch(error => console.error('SMS delivery failed:', error.message)); },
      signUpOnVerification: {
        getTempEmail(number) { return `${crypto.createHash('sha256').update(number).digest('hex').slice(0, 32)}@phone.ignifire.invalid`; },
        getTempName(number) { return `Listener ${number.slice(-4)}`; }
      }
    }),
    passkey({ rpID, rpName: 'Ignifire', origin: publicURL })
  ]
});
