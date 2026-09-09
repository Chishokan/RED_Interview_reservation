/** GET /api/slots?dept=xxx&schoolId=yyy — 保護者に見せる予約可能な枠 */
import { getAvailableSlots } from '../lib/store.js';
import { withErrorHandling, methodNotAllowed, noStore, resolveDepartment } from '../lib/http.js';

export default withErrorHandling(async (req, res) => {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  noStore(res);
  const dept = await resolveDepartment(req, res);
  if (!dept) return;
  const schoolId = req.query.schoolId;
  if (!schoolId) {
    return res.status(400).json({ ok: false, error: '校舎が指定されていません' });
  }
  res.status(200).json({ ok: true, slots: await getAvailableSlots(String(schoolId), dept.slug) });
});
