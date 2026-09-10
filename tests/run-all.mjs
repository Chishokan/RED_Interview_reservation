/**
 * 全テストを実行する。テストごとに環境変数が異なるため、別プロセスで動かす。
 * 実行: npm test
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const files = [
  'format.test.mjs',
  'auth.test.mjs',
  'store.test.mjs',
  'reminders.test.mjs',
  'mailer-gas.test.mjs',
  'api.test.mjs',
  'import.test.mjs',
];

let failed = 0;
for (const f of files) {
  console.log('\n────────────────────────────────────────');
  console.log('▶ ' + f);
  const res = spawnSync(process.execPath, [path.join(dir, f)], {
    stdio: 'inherit',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  if (res.status !== 0) failed++;
}

console.log('\n────────────────────────────────────────');
if (failed) {
  console.error(`❌ ${failed} 個のテストファイルが失敗しました。`);
  process.exit(1);
}
console.log('✅ すべてのテストが通りました。');
