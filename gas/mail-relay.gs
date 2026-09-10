/**
 * メール送信の中継(Google Apps Script)
 *
 * Vercel上の面談予約システムから呼ばれて、MailApp でメールを送る。
 * 送信元がGoogleのサーバーになるため、レンタルサーバー側の国外IP制限に
 * 引っかからない。SPF/DKIM等のDNS設定も不要。
 *
 * ■ 使い方
 *   1. script.google.com で新しいプロジェクトを作り、このファイルを貼り付ける
 *   2. 下の TOKEN を、自分で作った長いランダム文字列に置き換える
 *   3. 「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」
 *        次のユーザーとして実行 : 自分
 *        アクセスできるユーザー : 全員          ← ここが「自分のみ」だと動きません
 *   4. 発行された /exec のURLを Vercel の GAS_MAIL_URL に、
 *      TOKEN と同じ文字列を GAS_MAIL_TOKEN に設定する
 *
 * ■ 注意
 *   - 差出人はこのスクリプトを実行するGoogleアカウントに固定されます
 *   - 1日の送信上限があります(無料の@gmailは100通/日、Workspaceは1500通/日)
 *   - URLとTOKENを知っていれば誰でもこのアカウントからメールを送れます。
 *     TOKENは必ず長いランダム文字列にし、外部に出さないでください
 */

// ★ここを書き換える(例: openssl rand -base64 32 で作った文字列)
const TOKEN = 'ここに長いランダムな文字列を貼り付ける';

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return json({ ok: false, error: 'リクエスト本文がありません' });
    }
    const body = JSON.parse(e.postData.contents);

    // 合言葉が違うリクエストは、何をしようとしていても受け付けない
    if (String(body.token || '') !== TOKEN) {
      return json({ ok: false, error: 'unauthorized' });
    }

    // 残り送信可能数の問い合わせ(メールは送らない)
    if (body.action === 'quota') {
      return json({ ok: true, remaining: MailApp.getRemainingDailyQuota() });
    }

    const to = String(body.to || '').trim();
    if (!to) return json({ ok: false, error: 'no-recipient' });

    MailApp.sendEmail({
      to: to,
      subject: String(body.subject || '(件名なし)'),
      body: String(body.text || ''),
      name: String(body.fromName || '面談予約システム'),
    });

    return json({ ok: true, remaining: MailApp.getRemainingDailyQuota() });
  } catch (err) {
    return json({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * 動作確認用。GASのエディタ上でこの関数を実行すると、
 * 自分宛にテストメールが届く(初回はメール送信の権限承認を求められる)。
 */
function testSend() {
  const me = Session.getActiveUser().getEmail();
  MailApp.sendEmail({
    to: me,
    subject: '【テスト】面談予約システムのメール中継',
    body: 'この中継スクリプトからメールを送信できています。\n'
        + '残り送信可能数: ' + MailApp.getRemainingDailyQuota() + '通',
    name: '面談予約システム',
  });
  Logger.log('送信しました: ' + me);
}
