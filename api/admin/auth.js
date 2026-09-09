/**
 * 管理画面の認証API(部門ごと)。
 *   GET  /api/admin/auth?dept=xxx   ログイン状態の確認
 *   POST /api/admin/auth            { dept, action: 'login', id, password } / { dept, action: 'logout' }
 */
import {
  verifyCredentials,
  createSessionToken,
  isAuthenticated,
  setSessionCookie,
  clearSessionCookie,
} from '../../lib/auth.js';
import {
  readJsonBody, withErrorHandling, methodNotAllowed, noStore, resolveDepartment,
} from '../../lib/http.js';

export default withErrorHandling(async (req, res) => {
  noStore(res);

  if (req.method === 'GET') {
    const dept = await resolveDepartment(req, res);
    if (!dept) return;
    return res.status(200).json({
      ok: true,
      loggedIn: isAuthenticated(req, dept.slug),
      department: { slug: dept.slug, name: dept.name, accentColor: dept.accent_color },
    });
  }

  if (req.method === 'POST') {
    const body = await readJsonBody(req);
    const dept = await resolveDepartment(req, res, body);
    if (!dept) return;

    if (body.action === 'logout') {
      clearSessionCookie(res, dept.slug);
      return res.status(200).json({ ok: true, loggedIn: false });
    }

    let valid;
    try {
      valid = verifyCredentials(dept.slug, body.id, body.password);
    } catch (err) {
      // 環境変数の設定漏れは、認証失敗と区別できるようにそのまま伝える
      return res.status(500).json({ ok: false, error: err.message });
    }
    if (!valid) {
      return res
        .status(401)
        .json({ ok: false, error: 'IDまたはパスワードが正しくありません' });
    }
    setSessionCookie(res, dept.slug, createSessionToken(dept.slug));
    return res.status(200).json({ ok: true, loggedIn: true });
  }

  return methodNotAllowed(res, ['GET', 'POST']);
});
