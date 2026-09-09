/**
 * GET /api/schools?dept=xxx
 * その部門の校舎マスタと、画面の見た目に必要な情報を返す。
 */
import { listSchoolsForClient } from '../lib/schools.js';
import { withErrorHandling, methodNotAllowed, noStore, resolveDepartment } from '../lib/http.js';

export default withErrorHandling(async (req, res) => {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  noStore(res);
  const dept = await resolveDepartment(req, res);
  if (!dept) return;
  res.status(200).json({
    ok: true,
    department: {
      slug: dept.slug,
      name: dept.name,
      accentColor: dept.accent_color,
      grades: dept.grades || [],
    },
    schools: await listSchoolsForClient(dept.slug),
  });
});
