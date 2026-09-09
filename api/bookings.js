/**
 * 保護者用の予約API。すべて部門(dept)つきで呼ぶ。
 *   GET    /api/bookings?dept=xxx&email=...  自分の予約一覧(その部門のみ)
 *   POST   /api/bookings                     予約する
 *   PATCH  /api/bookings                     予約内容を変更する(本人のメール一致が必要)
 *   DELETE /api/bookings                     予約をキャンセルする(本人のメール一致が必要)
 */
import { createBooking, updateBooking, cancelBooking, getMyBookings } from '../lib/store.js';
import { notifyStaffNewBooking } from '../lib/notify.js';
import {
  readJsonBody, withErrorHandling, methodNotAllowed, noStore, resolveDepartment,
} from '../lib/http.js';

export default withErrorHandling(async (req, res) => {
  noStore(res);

  if (req.method === 'GET') {
    const dept = await resolveDepartment(req, res);
    if (!dept) return;
    const email = req.query.email;
    if (!email) return res.status(400).json({ ok: false, error: 'メールアドレスが必要です' });
    return res.status(200).json({
      ok: true,
      bookings: await getMyBookings(String(email), dept.slug),
    });
  }

  if (req.method === 'POST' || req.method === 'PATCH' || req.method === 'DELETE') {
    const body = await readJsonBody(req);
    const dept = await resolveDepartment(req, res, body);
    if (!dept) return;
    const payload = { ...body, dept: dept.slug };

    if (req.method === 'POST') {
      const result = await createBooking(payload);
      if (!result.ok) return res.status(200).json(result);
      // 担当者への通知は予約成立後に行う(失敗しても予約は有効)
      await notifyStaffNewBooking(result.booking);
      return res.status(200).json({ ok: true, id: result.id });
    }
    if (req.method === 'PATCH') {
      return res.status(200).json(await updateBooking(payload));
    }
    return res.status(200).json(await cancelBooking(payload));
  }

  return methodNotAllowed(res, ['GET', 'POST', 'PATCH', 'DELETE']);
});
