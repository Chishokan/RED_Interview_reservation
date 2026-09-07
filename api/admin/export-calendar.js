/**
 * POST /api/admin/export-calendar (要ログイン)
 * 指定期間の予約を月カレンダー形式のスプレッドシートに書き出す。
 */
import { exportCalendar } from '../../lib/calendar-export.js';
import { requireAdmin } from '../../lib/auth.js';
import { readJsonBody, withErrorHandling, methodNotAllowed, noStore } from '../../lib/http.js';

export default withErrorHandling(async (req, res) => {
  noStore(res);
  if (!requireAdmin(req, res)) return;
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  res.status(200).json(await exportCalendar(await readJsonBody(req)));
});
