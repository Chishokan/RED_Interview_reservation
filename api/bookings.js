/**
 * 保護者用の予約API。
 *   GET    /api/bookings?email=...  自分の予約一覧
 *   POST   /api/bookings            予約する
 *   PATCH  /api/bookings            予約内容を変更する(本人のメール一致が必要)
 *   DELETE /api/bookings            予約をキャンセルする(本人のメール一致が必要)
 */
import { createBooking, updateBooking, cancelBooking, getMyBookings } from '../lib/store.js';
import { notifyStaffNewBooking } from '../lib/notify.js';
import { readJsonBody, withErrorHandling, methodNotAllowed, noStore } from '../lib/http.js';

export default withErrorHandling(async (req, res) => {
  noStore(res);

  if (req.method === 'GET') {
    const email = req.query.email;
    if (!email) return res.status(400).json({ ok: false, error: 'メールアドレスが必要です' });
    const bookings = await getMyBookings(String(email));
    return res.status(200).json({ ok: true, bookings });
  }

  if (req.method === 'POST') {
    const body = await readJsonBody(req);
    const result = await createBooking(body);
    if (!result.ok) return res.status(200).json(result);
    // 担当者への通知は予約成立後に行う(失敗しても予約は有効)
    await notifyStaffNewBooking(result.booking);
    return res.status(200).json({ ok: true, id: result.id });
  }

  if (req.method === 'PATCH') {
    const body = await readJsonBody(req);
    return res.status(200).json(await updateBooking(body));
  }

  if (req.method === 'DELETE') {
    const body = await readJsonBody(req);
    return res.status(200).json(await cancelBooking(body));
  }

  return methodNotAllowed(res, ['GET', 'POST', 'PATCH', 'DELETE']);
});
