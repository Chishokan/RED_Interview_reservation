/**
 * 智翔館アプリ(メニュー画面)からの自動ログイン。
 *   GET /api/admin/sso?token=xxx
 * トークンが正しければその部門のログインCookieを発行し、/<部門>/admin へ移動する。
 * だめなら /<部門>/admin?sso=failed(部門が分からなければ /)へ移動し、
 * 管理画面では従来どおりIDとパスワードでログインしてもらう。
 */
import { createSessionToken, setSessionCookie } from '../../lib/auth.js';
import { verifySsoToken } from '../../lib/sso.js';
import { withErrorHandling, methodNotAllowed, noStore } from '../../lib/http.js';
import { findDepartmentBySlug } from '../../lib/schools.js';

function redirect(res, location) {
  res.statusCode = 302;
  res.setHeader('Location', location);
  res.end();
}

export default withErrorHandling(async (req, res) => {
  noStore(res);
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  const claims = verifySsoToken(String((req.query && req.query.token) || ''));
  const dept = claims ? await findDepartmentBySlug(claims.dept) : null;
  if (!claims || !dept) {
    const fallback = String((req.query && req.query.dept) || '');
    return redirect(res, /^[a-z0-9_-]+$/.test(fallback) ? `/${fallback}/admin?sso=failed` : '/');
  }

  setSessionCookie(res, dept.slug, createSessionToken(dept.slug));
  console.log(`[sso] ${dept.slug} 管理画面に自動ログイン: ${claims.campus} ${claims.name}`);
  return redirect(res, `/${dept.slug}/admin`);
});
