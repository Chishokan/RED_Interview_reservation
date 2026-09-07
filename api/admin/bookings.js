/**
 * 管理画面の予約管理API(要ログイン)。
 *   GET    /api/admin/bookings?schoolId=xxx  校舎の全予約
 *   PATCH  /api/admin/bookings               予約を部分更新(日時・担当・面談記録など)
 *   DELETE /api/admin/bookings               予約をキャンセル
 */
import { getAllBookings, adminUpdateBooking, adminCancelBooking } from '../../lib/store.js';
import { requireAdmin } from '../../lib/auth.js';
import { readJsonBody, withErrorHandling, methodNotAllowed, noStore } from '../../lib/http.js';

export default withErrorHandling(async (req, res) => {
  noStore(res);
  if (!requireAdmin(req, res)) return;

  if (req.method === 'GET') {
    const schoolId = req.query.schoolId;
    if (!schoolId) return res.status(400).json({ ok: false, error: '校舎が指定されていません' });
    return res.status(200).json({ ok: true, bookings: await getAllBookings(String(schoolId)) });
  }

  if (req.method === 'PATCH') {
    return res.status(200).json(await adminUpdateBooking(await readJsonBody(req)));
  }

  if (req.method === 'DELETE') {
    return res.status(200).json(await adminCancelBooking(await readJsonBody(req)));
  }

  return methodNotAllowed(res, ['GET', 'PATCH', 'DELETE']);
});
