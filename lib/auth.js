/**
 * 管理画面の認証。
 *
 * GAS版はHTML内にIDとパスワードが直書きされていて、ブラウザの
 * localStorage を見るだけの「画面上だけの鍵」だった。Vercelでは
 * APIがインターネットに公開されるため、サーバー側で認証し、
 * 署名付きCookieでセッションを保持する方式にしている。
 *
 * 環境変数:
 *   ADMIN_ID        管理画面のログインID
 *   ADMIN_PASSWORD  管理画面のパスワード
 *   SESSION_SECRET  Cookie署名用の秘密鍵(必須)
 */

import crypto from 'node:crypto';

const COOKIE_NAME = 'admin_session';
const SESSION_MAX_AGE_SEC = 60 * 60 * 12; // 12時間

/**
 * Cookieの署名鍵は、短いと総当たりで偽のログインCookieを作られてしまう。
 * 24文字未満は事故なので、その場で気づけるようエラーにする。
 */
const MIN_SECRET_LENGTH = 24;

function getSecret() {
  const s = process.env.SESSION_SECRET;
  if (!s) {
    throw new Error(
      'SESSION_SECRET が設定されていません。' +
        '`openssl rand -base64 32` などで作った長いランダムな文字列を設定してください。'
    );
  }
  if (s.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `SESSION_SECRET が短すぎます(${s.length}文字)。` +
        `推測されにくくするため${MIN_SECRET_LENGTH}文字以上にしてください。` +
        '`openssl rand -base64 32` などで生成できます。'
    );
  }
  return s;
}

/** 長さに依存しない比較(タイミング攻撃対策) */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** IDとパスワードを検証する */
export function verifyCredentials(id, password) {
  const validId = process.env.ADMIN_ID;
  const validPw = process.env.ADMIN_PASSWORD;
  if (!validId || !validPw) {
    throw new Error(
      '管理画面のIDとパスワードが未設定です。ADMIN_ID と ADMIN_PASSWORD を設定してください。'
    );
  }
  // 片方だけ一致した場合に処理時間で差が出ないよう、両方を必ず評価する
  const idOk = safeEqual(id || '', validId);
  const pwOk = safeEqual(password || '', validPw);
  return idOk && pwOk;
}

function sign(payload) {
  return crypto.createHmac('sha256', getSecret()).update(payload).digest('base64url');
}

/** セッショントークンを作る(内容は「発行時刻.署名」だけ) */
export function createSessionToken() {
  const payload = `${process.env.ADMIN_ID}.${Date.now()}`;
  const encoded = Buffer.from(payload).toString('base64url');
  return `${encoded}.${sign(encoded)}`;
}

/** セッショントークンを検証する */
export function verifySessionToken(token) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [encoded, signature] = parts;
  if (!safeEqual(signature, sign(encoded))) return false;
  let payload;
  try {
    payload = Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    return false;
  }
  const issuedAt = Number(payload.split('.').pop());
  if (!Number.isFinite(issuedAt)) return false;
  if (Date.now() - issuedAt > SESSION_MAX_AGE_SEC * 1000) return false;
  // 有効期間中でも、ログインIDが変わっていたらセッションを無効にする
  return payload.startsWith(`${process.env.ADMIN_ID}.`);
}

/** リクエストのCookieを { name: value } に分解する */
export function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx < 0) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

/** ログイン済みかどうか */
export function isAuthenticated(req) {
  return verifySessionToken(parseCookies(req)[COOKIE_NAME]);
}

export function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', [
    `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${SESSION_MAX_AGE_SEC}`,
  ]);
}

export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', [
    `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0`,
  ]);
}

/**
 * 管理APIのガード。未ログインなら401を返して false を返す。
 */
export function requireAdmin(req, res) {
  if (isAuthenticated(req)) return true;
  res.status(401).json({ ok: false, error: 'ログインが必要です', needLogin: true });
  return false;
}
