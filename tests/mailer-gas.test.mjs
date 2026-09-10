/** GAS経由のメール送信のテスト(GASのWebアプリをモックして検証する) */
import assert from 'node:assert/strict';

process.env.MAIL_FROM = '智翔館 面談予約 <noreply@chishokan.co.jp>';
process.env.GAS_MAIL_URL = 'https://script.google.com/macros/s/AAA/exec';
process.env.GAS_MAIL_TOKEN = 'secret-token';

const { sendMail, mailerMode, mailQuota } = await import('../lib/mailer.js');

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log('  ✓', name);
    passed++;
  } catch (err) {
    console.error('  ✗', name);
    throw err;
  }
}

/** 直近のGASリクエストを捕まえるためのモック */
let lastRequest = null;
function mockGas(responder) {
  globalThis.fetch = async (url, opts) => {
    lastRequest = { url, body: JSON.parse(opts.body) };
    const r = responder(lastRequest);
    return {
      ok: true,
      status: r.status || 200,
      url: r.url || url,
      text: async () => r.text,
    };
  };
}

console.log('\n== GAS経由のメール送信 ==');

await test('GAS_MAIL_URL があれば送信方法は gas になる', () => {
  assert.equal(mailerMode(), 'gas');
});

await test('宛先・件名・本文・表示名・合言葉をGASに渡す', async () => {
  mockGas(() => ({ text: JSON.stringify({ ok: true, remaining: 97 }) }));
  const res = await sendMail({ to: 'staff@x.jp', subject: '件名', text: '本文' });

  assert.equal(res.sent, true);
  assert.equal(res.via, 'gas');
  assert.equal(res.remaining, 97);
  assert.equal(lastRequest.url, process.env.GAS_MAIL_URL);
  assert.equal(lastRequest.body.token, 'secret-token');
  assert.equal(lastRequest.body.to, 'staff@x.jp');
  assert.equal(lastRequest.body.subject, '件名');
  assert.equal(lastRequest.body.text, '本文');
  // MAIL_FROM のうち、GASに渡せるのは表示名だけ
  assert.equal(lastRequest.body.fromName, '智翔館 面談予約');
});

await test('複数宛先はカンマ区切りにまとめて渡す', async () => {
  mockGas(() => ({ text: JSON.stringify({ ok: true }) }));
  await sendMail({ to: ['a@x.jp', 'b@x.jp'], subject: 's', text: 't' });
  assert.equal(lastRequest.body.to, 'a@x.jp,b@x.jp');
});

await test('合言葉が違うと、その旨が分かるエラーになる', async () => {
  mockGas(() => ({ text: JSON.stringify({ ok: false, error: 'unauthorized' }) }));
  await assert.rejects(
    () => sendMail({ to: 'a@x.jp', subject: 's', text: 't' }),
    /GAS_MAIL_TOKEN がGAS側のTOKENと一致していません/,
  );
});

await test('公開設定を誤ってHTMLが返ったら、直し方が分かるエラーになる', async () => {
  mockGas(() => ({
    text: '<!DOCTYPE html><html><head><title>ログイン</title></head></html>',
    url: 'https://accounts.google.com/signin',
  }));
  await assert.rejects(
    () => sendMail({ to: 'a@x.jp', subject: 's', text: 't' }),
    /アクセスできるユーザー.*全員/s,
  );
});

await test('GAS側のエラーはそのまま伝える', async () => {
  mockGas(() => ({ text: JSON.stringify({ ok: false, error: '送信上限に達しました' }) }));
  await assert.rejects(
    () => sendMail({ to: 'a@x.jp', subject: 's', text: 't' }),
    /送信上限に達しました/,
  );
});

await test('残りの送信可能数を問い合わせられる', async () => {
  mockGas(() => ({ text: JSON.stringify({ ok: true, remaining: 42 }) }));
  assert.equal(await mailQuota(), 42);
  assert.equal(lastRequest.body.action, 'quota');
});

await test('宛先が空なら、GASを呼ばずに終わる', async () => {
  lastRequest = null;
  const res = await sendMail({ to: '', subject: 's', text: 't' });
  assert.equal(res.sent, false);
  assert.equal(res.reason, 'no-recipient');
  assert.equal(lastRequest, null);
});

console.log(`\n${passed} 件のテストが通りました。`);
