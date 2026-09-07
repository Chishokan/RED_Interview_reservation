/** GET /api/slots?schoolId=xxx — 保護者に見せる予約可能な枠 */
import { getAvailableSlots } from '../lib/store.js';
import { withErrorHandling, methodNotAllowed, noStore } from '../lib/http.js';

export default withErrorHandling(async (req, res) => {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  noStore(res);
  const schoolId = req.query.schoolId;
  if (!schoolId) {
    return res.status(400).json({ ok: false, error: '校舎が指定されていません' });
  }
  const slots = await getAvailableSlots(String(schoolId));
  res.status(200).json({ ok: true, slots });
});
