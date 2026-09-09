/**
 * LINE WORKS Bot へのメッセージ送信。
 * 中等部のGAS版が使っていた通知方法を移植したもの。
 *
 * サービスアカウントの秘密鍵でJWTを作り、アクセストークンと交換してから
 * Botのトークルームにメッセージを送る。
 *
 * 必要な環境変数(すべて設定されていないと送信しない):
 *   LINE_WORKS_CLIENT_ID
 *   LINE_WORKS_CLIENT_SECRET
 *   LINE_WORKS_SERVICE_ACCOUNT
 *   LINE_WORKS_PRIVATE_KEY   -----BEGIN PRIVATE KEY----- から始まる鍵(改行は \n でも可)
 *   LINE_WORKS_BOT_ID
 */

import crypto from 'node:crypto';

const AUTH_ENDPOINT = 'https://auth.worksmobile.com/oauth2/v2.0/token';
const API_BASE = 'https://www.worksapis.com/v1.0';
const SCOPE = 'bot,bot.read';

/** 必要な設定がそろっているか */
export function isLineWorksConfigured() {
  return Boolean(
    process.env.LINE_WORKS_CLIENT_ID &&
      process.env.LINE_WORKS_CLIENT_SECRET &&
      process.env.LINE_WORKS_SERVICE_ACCOUNT &&
      process.env.LINE_WORKS_PRIVATE_KEY &&
      process.env.LINE_WORKS_BOT_ID
  );
}

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

/** 環境変数の秘密鍵を、改行が \n で入っていても使える形に直す */
function privateKey() {
  return String(process.env.LINE_WORKS_PRIVATE_KEY || '').replace(/\\n/g, '\n');
}

// アクセストークンは1時間有効。関数の実行中は使い回す。
let tokenCache = null;

/** アクセストークンを取得する(有効期限内ならキャッシュを返す) */
export async function getAccessToken() {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60 * 1000) {
    return tokenCache.token;
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      iss: process.env.LINE_WORKS_CLIENT_ID,
      sub: process.env.LINE_WORKS_SERVICE_ACCOUNT,
      iat: nowSec,
      exp: nowSec + 3600,
    })
  );
  const signature = crypto
    .createSign('RSA-SHA256')
    .update(`${header}.${claims}`)
    .sign(privateKey(), 'base64url');
  const jwt = `${header}.${claims}.${signature}`;

  const res = await fetch(AUTH_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      assertion: jwt,
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      client_id: process.env.LINE_WORKS_CLIENT_ID,
      client_secret: process.env.LINE_WORKS_CLIENT_SECRET,
      scope: SCOPE,
    }),
  });
  if (!res.ok) {
    throw new Error(`LINE WORKSの認証に失敗しました (${res.status}): ${await res.text()}`);
  }
  const data = await res.json();
  if (!data.access_token) {
    throw new Error('LINE WORKSの認証応答にアクセストークンがありませんでした');
  }
  tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000,
  };
  return tokenCache.token;
}

/** テスト用にトークンのキャッシュを捨てる */
export function clearTokenCache() {
  tokenCache = null;
}

/**
 * トークルームにテキストメッセージを送る。
 * @param {string} channelId 送信先のトークルームID
 * @param {string} text 本文
 */
export async function sendChannelMessage(channelId, text) {
  if (!isLineWorksConfigured()) return { sent: false, reason: 'not-configured' };
  if (!channelId) return { sent: false, reason: 'no-channel' };

  const token = await getAccessToken();
  const url = `${API_BASE}/bots/${process.env.LINE_WORKS_BOT_ID}/channels/${channelId}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ content: { type: 'text', text } }),
  });
  if (!res.ok) {
    // トークンが失効している可能性があるので、次回は取り直す
    tokenCache = null;
    throw new Error(`LINE WORKSの送信に失敗しました (${res.status}): ${await res.text()}`);
  }
  return { sent: true, via: 'lineworks' };
}
