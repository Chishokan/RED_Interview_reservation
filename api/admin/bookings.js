/**
 * 管理画面の予約管理API(要ログイン・部門ごと)。
 *   GET    /api/admin/bookings?dept=xxx&schoolId=yyy  校舎の全予約
 *   PATCH  /api/admin/bookings                        予約を部分更新
 *   DELETE /api/admin/bookings                        予約をキャンセル
 */
import { getAllBookings, adminUpdateBooking, adminCancelBooking } from '../../lib/store.js';
import { requireAdmin } from '../../lib/auth.js';
import {
  readJsonBody, withErrorHandling, methodNotAllowed, noStore, resolveDepartment,
} from '../../lib/http.js';

export default withErrorHandling(async (req, res) => {
  noStore(res);

  if (req.method === 'GET') {
    const dept = await resolveDepartment(req, res);
    if (!dept) return;
    if (!requireAdmin(req, res, dept.slug)) return;
    const schoolId = req.query.schoolId;
    if (!schoolId) return res.status(400).json({ ok: false, error: '校舎が指定されていません' });
    return res.status(200).json({
      ok: true,
      bookings: await getAllBookings(String(schoolId), dept.slug),
    });
  }

  if (req.method === 'PATCH' || req.method === 'DELETE') {
    const body = await readJsonBody(req);
    const dept = await resolveDepartment(req, res, body);
    if (!dept) return;
    if (!requireAdmin(req, res, dept.slug)) return;
    const payload = { ...body, dept: dept.slug };
    if (req.method === 'PATCH') {
      return res.status(200).json(await adminUpdateBooking(payload));
    }
    return res.status(200).json(await adminCancelBooking(payload));
  }

  return methodNotAllowed(res, ['GET', 'PATCH', 'DELETE']);
});
