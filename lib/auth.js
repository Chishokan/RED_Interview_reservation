/**
 * 管理画面の認証。
 *
 * GAS版はHTML内にIDとパスワードが直書きされていて、ブラウザの
 * localStorage を見るだけの「画面上だけの鍵」だった。Vercelでは
 * APIがインターネットに公開されるため、サーバー側で認証し、
 * 署名付きCookieでセッションを保持する方式にしている。
 *
 * ログインは部門ごとに分かれている。Cookieにも部門を含めるので、
 * ある部門でログインしても別部門の管理APIは使えない。
 *
 * 環境変数:
 *   SESSION_SECRET          Cookie署名用の秘密鍵(必須)
 *   ADMIN_ID_<部門>         その部門のログインID    (例: ADMIN_ID_RED)
 *   ADMIN_PASSWORD_<部門>   その部門のパスワード     (例: ADMIN_PASSWORD_RED)
 *   ADMIN_ID / ADMIN_PASSWORD  部門ごとの設定が無いときに使う共通の値
 */

import crypto from 'node:crypto';

const SESSION_MAX_AGE_SEC = 60 * 60 * 12; // 12時間

/**
 * 部門ごとに別のCookieを使う。
 * こうしておくと、両部門を見る職員が切り替えのたびに
 * ログインし直さずに済む。
 */
function cookieName(dept) {
  return `admin_session_${String(dept).replace(/[^A-Za-z0-9_-]/g, '')}`;
}

/** 環境変数名に使えるよう、部門のslugを大文字英数字に直す */
function envSuffix(dept) {
  return String(dept).toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

/** その部門のログインID・パスワードを取り出す(部門別 → 共通の順に探す) */
function credentialsFor(dept) {
  const suffix = envSuffix(dept);
  return {
    id: process.env[`ADMIN_ID_${suffix}`] || process.env.ADMIN_ID,
    password: process.env[`ADMIN_PASSWORD_${suffix}`] || process.env.ADMIN_PASSWORD,
  };
}

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

/** その部門のIDとパスワードを検証する */
export function verifyCredentials(dept, id, password) {
  const { id: validId, password: validPw } = credentialsFor(dept);
  if (!validId || !validPw) {
    const suffix = envSuffix(dept);
    throw new Error(
      '管理画面のIDとパスワードが未設定です。' +
        `ADMIN_ID_${suffix} と ADMIN_PASSWORD_${suffix}` +
        '(または共通の ADMIN_ID と ADMIN_PASSWORD)を設定してください。'
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

/** セッショントークンを作る(内容は「部門・ログインID・発行時刻」と署名) */
export function createSessionToken(dept) {
  const { id } = credentialsFor(dept);
  const payload = JSON.stringify({ dept: String(dept), id, at: Date.now() });
  const encoded = Buffer.from(payload).toString('base64url');
  return `${encoded}.${sign(encoded)}`;
}

/** セッショントークンを検証する。指定した部門のものでなければ false */
export function verifySessionToken(token, dept) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [encoded, signature] = parts;
  if (!safeEqual(signature, sign(encoded))) return false;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return false;
  }
  if (!payload || typeof payload !== 'object') return false;
  if (!Number.isFinite(payload.at)) return false;
  if (Date.now() - payload.at > SESSION_MAX_AGE_SEC * 1000) return false;
  // 別部門のCookieを使い回せないようにする
  if (String(payload.dept) !== String(dept)) return false;
  // 有効期間中でも、ログインIDが変わっていたらセッションを無効にする
  return payload.id === credentialsFor(dept).id;
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

/** その部門にログイン済みかどうか */
export function isAuthenticated(req, dept) {
  return verifySessionToken(parseCookies(req)[cookieName(dept)], dept);
}

export function setSessionCookie(res, dept, token) {
  res.setHeader('Set-Cookie', [
    `${cookieName(dept)}=${token}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${SESSION_MAX_AGE_SEC}`,
  ]);
}

export function clearSessionCookie(res, dept) {
  res.setHeader('Set-Cookie', [
    `${cookieName(dept)}=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0`,
  ]);
}

/**
 * 管理APIのガード。その部門にログインしていなければ401を返して false を返す。
 */
export function requireAdmin(req, res, dept) {
  if (dept && isAuthenticated(req, dept)) return true;
  res.status(401).json({ ok: false, error: 'ログインが必要です', needLogin: true });
  return false;
}
