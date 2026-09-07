/**
 * APIハンドラ共通のヘルパー。
 */

/** リクエストボディをJSONとして取り出す(Vercelが解析済みならそれを使う) */
export async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body) {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

/**
 * ハンドラを包んで、例外を { ok:false, error } のJSONに変換する。
 * クライアント側はどのAPIでも同じ形で結果を受け取れる。
 */
export function withErrorHandling(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      console.error(`[api] ${req.method} ${req.url} でエラー:`, err);
      if (!res.headersSent) {
        res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err) });
      }
    }
  };
}

/** 許可されていないHTTPメソッドを弾く */
export function methodNotAllowed(res, allowed) {
  res.setHeader('Allow', allowed.join(', '));
  res.status(405).json({ ok: false, error: 'このメソッドは使用できません' });
}

/** キャッシュさせない(予約状況は常に最新を返す) */
export function noStore(res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
}
