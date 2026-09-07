/**
 * 管理画面の枠管理API(要ログイン)。
 *   GET    /api/admin/slots?schoolId=xxx   全ての枠
 *   POST   /api/admin/slots                { schoolId, slots: [...] } 枠を追加
 *   PATCH  /api/admin/slots                1件更新、または { action:'bulkCapacity' } で一括変更
 *   DELETE /api/admin/slots                { id } 1件削除 / { ids } 一括削除
 */
import {
  getAllSlots,
  adminAddSlots,
  adminUpdateSlot,
  adminBulkUpdateCapacity,
  adminDeleteSlot,
  adminDeleteSlots,
} from '../../lib/store.js';
import { requireAdmin } from '../../lib/auth.js';
import { readJsonBody, withErrorHandling, methodNotAllowed, noStore } from '../../lib/http.js';

export default withErrorHandling(async (req, res) => {
  noStore(res);
  if (!requireAdmin(req, res)) return;

  if (req.method === 'GET') {
    const schoolId = req.query.schoolId;
    if (!schoolId) return res.status(400).json({ ok: false, error: '校舎が指定されていません' });
    return res.status(200).json({ ok: true, slots: await getAllSlots(String(schoolId)) });
  }

  if (req.method === 'POST') {
    return res.status(200).json(await adminAddSlots(await readJsonBody(req)));
  }

  if (req.method === 'PATCH') {
    const body = await readJsonBody(req);
    if (body.action === 'bulkCapacity') {
      return res.status(200).json(await adminBulkUpdateCapacity(body));
    }
    return res.status(200).json(await adminUpdateSlot(body));
  }

  if (req.method === 'DELETE') {
    const body = await readJsonBody(req);
    if (Array.isArray(body.ids)) {
      return res.status(200).json(await adminDeleteSlots(body));
    }
    return res.status(200).json(await adminDeleteSlot(body));
  }

  return methodNotAllowed(res, ['GET', 'POST', 'PATCH', 'DELETE']);
});
