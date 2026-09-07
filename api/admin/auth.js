/**
 * 管理画面の認証API。
 *   GET  /api/admin/auth            ログイン状態の確認
 *   POST /api/admin/auth            { action: 'login', id, password } / { action: 'logout' }
 */
import {
  verifyCredentials,
  createSessionToken,
  isAuthenticated,
  setSessionCookie,
  clearSessionCookie,
} from '../../lib/auth.js';
import { readJsonBody, withErrorHandling, methodNotAllowed, noStore } from '../../lib/http.js';

export default withErrorHandling(async (req, res) => {
  noStore(res);

  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, loggedIn: isAuthenticated(req) });
  }

  if (req.method === 'POST') {
    const body = await readJsonBody(req);

    if (body.action === 'logout') {
      clearSessionCookie(res);
      return res.status(200).json({ ok: true, loggedIn: false });
    }

    let valid;
    try {
      valid = verifyCredentials(body.id, body.password);
    } catch (err) {
      // 環境変数の設定漏れは、認証失敗と区別できるようにそのまま伝える
      return res.status(500).json({ ok: false, error: err.message });
    }
    if (!valid) {
      return res
        .status(401)
        .json({ ok: false, error: 'IDまたはパスワードが正しくありません' });
    }
    setSessionCookie(res, createSessionToken());
    return res.status(200).json({ ok: true, loggedIn: true });
  }

  return methodNotAllowed(res, ['GET', 'POST']);
});
