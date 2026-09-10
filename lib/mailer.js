/**
 * メール送信。
 *
 * 送信手段は環境変数で切り替わる(上から順に判定):
 *   1. GAS_MAIL_URL があれば Google Apps Script の中継を使う
 *   2. RESEND_API_KEY があれば Resend の HTTP API を使う
 *   3. SMTP_HOST 等があれば nodemailer で SMTP 送信
 *   4. どれも無ければ送信せずログに出すだけ(開発時)
 *
 * GAS中継は、送信元がGoogleのサーバーになるため、レンタルサーバーの
 * 国外IP制限に影響されない。DNSの設定も要らない。
 * ただし差出人アドレスはGASを実行するGoogleアカウント固定になり、
 * MAIL_FROM のうち反映されるのは表示名だけになる。
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
  if (process.env.GAS_MAIL_URL) return 'gas';
  if (process.env.RESEND_API_KEY) return 'resend';
  if (process.env.SMTP_HOST) return 'smtp';
  return 'none';
}

/** MAIL_FROM から表示名だけを取り出す(GASは差出人アドレスを指定できないため) */
function fromName() {
  const raw = process.env.MAIL_FROM || FROM;
  const m = String(raw).match(/^\s*(.+?)\s*<[^>]+>\s*$/);
  return (m ? m[1] : String(raw)).replace(/^"|"$/g, '').trim() || '面談予約システム';
}

/** GASのWebアプリはJSONを返すが、設定を誤るとログイン用HTMLが返ってくる */
async function callGas(payload) {
  const res = await fetch(process.env.GAS_MAIL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: process.env.GAS_MAIL_TOKEN || '', ...payload }),
    redirect: 'follow',
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  const body = await res.text();
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    if (/<html/i.test(body) || /accounts\.google\.com/.test(res.url || '')) {
      throw new Error(
        'GASがJSONではなくHTMLを返しました。ウェブアプリの「アクセスできるユーザー」を' +
        '「全員」にして再デプロイしてください。'
      );
    }
    throw new Error(`GASの応答を解釈できません (${res.status}): ${body.slice(0, 200)}`);
  }
  if (!data.ok) {
    if (data.error === 'unauthorized') {
      throw new Error('GAS_MAIL_TOKEN がGAS側のTOKENと一致していません。');
    }
    throw new Error(`GAS送信エラー: ${data.error || '原因不明'}`);
  }
  return data;
}

async function sendViaGas({ to, subject, text }) {
  return callGas({
    to: Array.isArray(to) ? to.join(',') : String(to),
    subject,
    text,
    fromName: fromName(),
  });
}

/** GAS経由のときだけ、その日の残り送信可能数を問い合わせる */
export async function mailQuota() {
  if (mailerMode() !== 'gas') return null;
  const data = await callGas({ action: 'quota' });
  return typeof data.remaining === 'number' ? data.remaining : null;
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
  if (mode === 'gas') {
    const data = await sendViaGas({ to, subject, text });
    return { sent: true, via: 'gas', remaining: data.remaining };
  }
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
