/** GET /api/schools — 校舎マスタを返す */
import { SCHOOLS } from '../lib/schools.js';
import { withErrorHandling, methodNotAllowed, noStore } from '../lib/http.js';

export default withErrorHandling(async (req, res) => {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  noStore(res);
  res.status(200).json({ ok: true, schools: SCHOOLS });
});
