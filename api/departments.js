/** GET /api/departments — 部門の一覧(トップの選択画面用) */
import { listDepartmentsForClient } from '../lib/schools.js';
import { withErrorHandling, methodNotAllowed, noStore } from '../lib/http.js';

export default withErrorHandling(async (req, res) => {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  noStore(res);
  res.status(200).json({ ok: true, departments: await listDepartmentsForClient() });
});
