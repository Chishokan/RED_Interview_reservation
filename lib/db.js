/**
 * Supabase クライアント。
 *
 * サーバー(Vercelのサーバーレス関数)からのみDBに触れるため、
 * RLSを迂回できる service_role キーを使う。
 * このキーは絶対にブラウザへ渡さないこと。
 *
 * 必要な環境変数:
 *   SUPABASE_URL              プロジェクトのURL (https://xxxx.supabase.co)
 *   SUPABASE_SERVICE_ROLE_KEY service_role キー
 */

import { createClient } from '@supabase/supabase-js';

let client = null;

export function getDb() {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      'Supabaseの接続情報が設定されていません。' +
        'SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY を設定してください。'
    );
  }
  client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { 'x-application-name': 'red-interview-reservation' } },
  });
  return client;
}

/** テスト用にクライアントを差し替える */
export function setDbForTesting(fake) {
  client = fake;
}

/**
 * Supabaseの応答を確認して data を返す。
 * エラーはそのまま例外にして、APIハンドラ側で {ok:false} に変換させる。
 */
export function unwrap({ data, error }, what) {
  if (error) {
    const detail = error.message || JSON.stringify(error);
    throw new Error(`${what}に失敗しました: ${detail}`);
  }
  return data;
}
