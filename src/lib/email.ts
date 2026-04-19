import 'server-only';
import nodemailer, { type Transporter } from 'nodemailer';
import { logger } from './logger';

type SmtpConfig = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
};

let cachedTransporter: Transporter | null = null;
let cachedFrom: string | null = null;

function readSmtpConfig(): SmtpConfig | null {
  const host = process.env.SMTP_HOST?.trim();
  const portStr = process.env.SMTP_PORT?.trim();
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS ?? '';
  const from = process.env.SMTP_FROM?.trim() || user || '';

  if (!host || !portStr || !user || !pass || !from) return null;

  const port = Number(portStr);
  if (!Number.isFinite(port)) return null;

  return {
    host,
    port,
    secure: port === 465,
    user,
    pass,
    from,
  };
}

function getTransporter(): { transporter: Transporter; from: string } | null {
  if (cachedTransporter && cachedFrom) {
    return { transporter: cachedTransporter, from: cachedFrom };
  }
  const config = readSmtpConfig();
  if (!config) return null;

  cachedTransporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.pass },
  });
  cachedFrom = config.from;
  return { transporter: cachedTransporter, from: cachedFrom };
}

export async function sendEmail(params: {
  to: string;
  cc?: string[];
  subject: string;
  html: string;
  text?: string;
}): Promise<{ sent: boolean; skipped?: string }> {
  const bundle = getTransporter();
  if (!bundle) {
    return { sent: false, skipped: 'SMTP not configured (set SMTP_HOST/PORT/USER/PASS/FROM)' };
  }

  try {
    await bundle.transporter.sendMail({
      from: bundle.from,
      to: params.to,
      cc: params.cc && params.cc.length > 0 ? params.cc : undefined,
      subject: params.subject,
      html: params.html,
      text: params.text,
    });
    return { sent: true };
  } catch (err) {
    logger.error('sendEmail failed', { to: params.to, subject: params.subject }, err instanceof Error ? err : undefined);
    return { sent: false, skipped: err instanceof Error ? err.message : 'unknown error' };
  }
}
