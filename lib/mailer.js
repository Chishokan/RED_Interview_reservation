/**
 * メール送信。GAS版の MailApp.sendEmail() の置き換え。
 *
 * 送信手段は環境変数で切り替わる:
 *   1. RESEND_API_KEY があれば Resend の HTTP API を使う(サーバーレス向き)
 *   2. SMTP_HOST 等があれば nodemailer で SMTP 送信
 *   3. どちらも無ければ送信せずログに出すだけ(開発時)
 *
 * 差出人は MAIL_FROM(例: 面談予約システム <noreply@example.com>)。
 */

const FROM = process.env.MAIL_FROM || '面談予約システム <onboarding@resend.dev>';

/**
 * 1通あたりの送信を打ち切るまでの時間。
 * 応答しないメールサーバーに当たったときに、呼び出し元(サーバーレス関数)の
 * 実行時間を使い切ってしまわないようにするための上限。
 */
const SEND_TIMEOUT_MS = 10000;

export function mailerMode() {
  if (process.env.RESEND_API_KEY) return 'resend';
  if (process.env.SMTP_HOST) return 'smtp';
  return 'none';
}

async function sendViaResend({ to, subject, text }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: FROM,
      to: Array.isArray(to) ? to : String(to).split(',').map((x) => x.trim()).filter(Boolean),
      subject,
      text,
    }),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend送信エラー (${res.status}): ${body}`);
  }
  return res.json();
}

let transporterPromise = null;

async function getTransporter() {
  if (!transporterPromise) {
    transporterPromise = import('nodemailer').then((mod) =>
      mod.default.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        secure: String(process.env.SMTP_SECURE || '') === 'true' || Number(process.env.SMTP_PORT) === 465,
        auth: process.env.SMTP_USER
          ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
          : undefined,
        // nodemailer の既定値(接続120秒・ソケット600秒)はサーバーレスには長すぎる
        connectionTimeout: 5000,
        greetingTimeout: 5000,
        socketTimeout: SEND_TIMEOUT_MS,
      })
    );
  }
  return transporterPromise;
}

async function sendViaSmtp({ to, subject, text }) {
  const transporter = await getTransporter();
  return transporter.sendMail({ from: FROM, to, subject, text });
}

/**
 * メールを1通送る。設定が無い場合はログに出して何もしない。
 * @param {{to: string, subject: string, text: string}} message
 */
export async function sendMail({ to, subject, text }) {
  if (!to) return { sent: false, reason: 'no-recipient' };
  const mode = mailerMode();
  if (mode === 'resend') {
    await sendViaResend({ to, subject, text });
    return { sent: true, via: 'resend' };
  }
  if (mode === 'smtp') {
    await sendViaSmtp({ to, subject, text });
    return { sent: true, via: 'smtp' };
  }
  console.log('[mailer] 送信設定が無いためスキップしました:', { to, subject });
  return { sent: false, reason: 'not-configured' };
}
