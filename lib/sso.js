/**
 * 智翔館アプリ(メニュー画面)からの自動ログイン。
 *
 * 智翔館アプリにログイン済みの職員がメニューの「面談管理」を押すと、
 * 智翔館アプリが「部門・氏名・有効期限」に署名した短命のトークンを付けて
 * /api/admin/sso に転送してくる。署名が正しく期限内なら、IDとパスワードで
 * ログインしたときと同じセッションCookieを発行する。
 *
 * どの部門の管理画面を開けるか(RED個別→red など)は智翔館アプリ側で判定済み。
 * こちらは「共有の秘密鍵で署名されているか」だけを確かめる。
 *
 * 環境変数:
 *   CHISHOKAN_SSO_SECRET  智翔館アプリと同じ値を設定する秘密鍵(24文字以上)。
 *                         未設定なら自動ログインは無効(従来どおりIDとパスワードで入る)。
 */

import crypto from 'node:crypto';

/** トークンの宛先。智翔館アプリ側と同じ文字列にする(別用途のトークンを流用させない) */
export const SSO_AUDIENCE = 'interview-admin';
/** 有効期限を遠くに設定したトークンを受け付けない上限(秒) */
const MAX_LIFETIME_SEC = 120;
/** サーバー間の時計のずれの許容(秒) */
const CLOCK_SKEW_SEC = 30;
const MIN_SECRET_LENGTH = 24;

/** 自動ログインが使える設定になっているか */
export function isSsoEnabled() {
  const s = process.env.CHISHOKAN_SSO_SECRET || '';
  return s.length >= MIN_SECRET_LENGTH;
}

function sign(encoded) {
  return crypto
    .createHmac('sha256', process.env.CHISHOKAN_SSO_SECRET)
    .update(encoded)
    .digest('base64url');
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * トークンを検証し、正しければ { dept, name, campus } を返す。だめなら null。
 * 失敗の理由は画面に出さない(手がかりを与えない)ので区別しない。
 */
export function verifySsoToken(token, now = Date.now()) {
  if (!isSsoEnabled()) return null;
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [encoded, signature] = parts;
  if (!safeEqual(signature, sign(encoded))) return null;

  let p;
  try {
    p = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!p || typeof p !== 'object') return null;
  if (p.aud !== SSO_AUDIENCE) return null;
  if (!Number.isFinite(p.iat) || !Number.isFinite(p.exp)) return null;
  const nowSec = Math.floor(now / 1000);
  if (p.exp < nowSec) return null; // 期限切れ
  if (p.iat > nowSec + CLOCK_SKEW_SEC) return null; // 未来に発行されている
  if (p.exp - p.iat > MAX_LIFETIME_SEC) return null; // 寿命が長すぎる
  if (typeof p.dept !== 'string' || !/^[a-z0-9_-]+$/.test(p.dept)) return null;
  return { dept: p.dept, name: String(p.name || ''), campus: String(p.campus || '') };
}
