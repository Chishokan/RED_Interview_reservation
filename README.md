# 面談予約システム (Vercel + Supabase版)

Google Apps Script (GAS) で動いていた面談予約システムを、**Vercel で動く Web アプリ**に移行したものです。
データは **Supabase (PostgreSQL)** に保存します。

- 保護者用画面: `https://<プロジェクト名>.vercel.app/`
- 職員用の管理画面: `https://<プロジェクト名>.vercel.app/admin`

---

## 1. 何が変わったか

| | GAS版 | 現在 |
|---|---|---|
| 画面の配信 | `doGet()` + `HtmlService` | `public/` の静的HTML |
| サーバー処理 | `google.script.run` | `/api/*` のREST API |
| データの保存先 | Googleスプレッドシート | **Supabase (PostgreSQL)** |
| 認証情報 | スクリプト実行者のアカウント | Supabaseのservice_roleキー |
| メール送信 | `MailApp` | Resend または SMTP |
| リマインドの定期実行 | 時間主導トリガー | Vercel Cron |
| 管理画面のログイン | HTMLに直書き(画面上だけの鍵) | サーバー側で検証 + 署名付きCookie |
| 二重予約の防止 | `LockService` | DBの行ロック(`create_booking` 関数) |
| 通知先の管理 | 「通知先」シート | 管理画面の「システム設定」タブ |
| カレンダー出力 | Googleスプレッドシートを生成 | **Excelファイル(.xlsx)をダウンロード** |

> ⚠️ **スプレッドシートは使わなくなります。**
> 職員の方がシートを直接開いて「面談記録」や「担当」を書き込む運用はできなくなり、
> これらは管理画面から入力する形になります。既存データは移行スクリプトで引き継げます(→ 4章)。

---

## 2. セットアップ手順

### 2-1. Supabaseプロジェクトを作る

1. [Supabase](https://supabase.com/) でアカウントを作り、新しいプロジェクトを作成する
2. リージョンは `Northeast Asia (Tokyo)` が近くて速いです
3. データベースのパスワードは控えておく(このアプリでは使いませんが、再発行が面倒なため)

### 2-2. テーブルを作る

1. Supabaseの左メニュー **SQL Editor** を開く
2. `supabase/schema.sql` の中身を貼り付けて実行する(テーブル・ビュー・関数・権限設定)
3. 続けて `supabase/seed.sql` を貼り付けて実行する(7校舎の初期データ)

どちらも**何度実行しても安全**です。

### 2-3. 接続情報を控える

Supabaseの **Project Settings → API** で次の2つを確認します。

- **Project URL** → `SUPABASE_URL`
- **service_role** キー(`secret` と表示されている方) → `SUPABASE_SERVICE_ROLE_KEY`

> 🔑 `service_role` キーはすべての権限を持ちます。**ブラウザに渡さず、サーバー側だけで使ってください。**
> このアプリは全テーブルでRLS(行レベルセキュリティ)を有効にし、ポリシーを1つも作らないことで、
> 万一 `anon` キーが漏れても何も読み書きできないようにしています。

### 2-4. Vercelにデプロイする

1. [Vercel](https://vercel.com/) でこのGitHubリポジトリをインポートする
2. フレームワークの指定は不要(`Other` のままでOK)
3. 「Environment Variables」に `.env.example` を参考にして値を設定する(→ 3章)
4. デプロイする

### 2-5. 通知先を設定する

`/admin` を開いてログインし、「🛠 システム設定」タブで各校舎の
**新規予約の通知先メールアドレス**を入力して保存します(空欄の校舎には通知されません)。

同じタブの「🔌 接続とデータの確認」で、DBに繋がっているかを確認できます。

---

## 3. 環境変数

`.env.example` に一覧とコメントがあります。最低限、次のものは必須です。

| 変数 | 説明 |
|---|---|
| `SUPABASE_URL` | SupabaseのProject URL |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role キー |
| `ADMIN_ID` / `ADMIN_PASSWORD` | 管理画面のログインID・パスワード |
| `SESSION_SECRET` | ログインCookieの署名鍵。`openssl rand -base64 32` などで生成した長い文字列 |
| `CRON_SECRET` | リマインドの定期実行を外部から勝手に叩かれないようにするトークン |

メール送信は `RESEND_API_KEY`(推奨)か、`SMTP_HOST` などのSMTP設定のどちらかを入れてください。
**どちらも未設定の場合、メールは送信されずログに記録されるだけ**になります(予約自体は正常に動きます)。

> ⚠️ `ADMIN_ID` と `ADMIN_PASSWORD` を設定しないと管理画面にログインできません。
> GAS版はIDとパスワードがHTMLに直書きされていましたが、Vercel版ではAPIが
> インターネットに公開されるため、サーバー側で検証する方式に変えています。
> **GAS版と同じパスワードは使わず、新しいものを設定してください。**

---

## 4. 既存データの移行

スプレッドシートに入っている予約データを、そのままSupabaseに移せます。
Googleの認証情報は必要ありません。

1. スプレッドシートを開き、**ファイル → ダウンロード → Microsoft Excel (.xlsx)**
   でダウンロードする(1つのファイルに全シートが入ります)
2. このリポジトリを手元にクローンし、`.env.local` に `SUPABASE_URL` と
   `SUPABASE_SERVICE_ROLE_KEY` を書く
3. 次を実行する

```bash
npm install
npm run import:xlsx -- ./ダウンロードしたファイル.xlsx --dry-run   # まず件数だけ確認
npm run import:xlsx -- ./ダウンロードしたファイル.xlsx             # 実際に取り込む
```

取り込まれるもの:

- 「通知先」シート → 校舎マスタの通知先アドレス
- 「〇〇予約枠」シート → 予約枠(日付・時刻・ラベル・公開・定員)
- 「〇〇予約データ」シート → 予約(予約IDをそのまま引き継ぐので、**何度実行しても重複しません**)

日付・時刻・日時のセルは日本時間として解釈して取り込みます。
予約IDが空の行、日時が読めない行、同じ日時の重複した枠は読み飛ばし、最後に件数を表示します。

---

## 5. リマインドメールの定期実行

`vercel.json` の `crons` で、1日2回リマインドを送るよう設定しています。

```
0 1 * * *   → 日本時間 10:00
0 10 * * *  → 日本時間 19:00
```

Vercel Cron のスケジュールは **UTC** で書きます。同じ予約には1通しか送られないため
(送信日時を `bookings.reminder_sent_at` に記録)、朝に失敗しても夜に拾える保険になっています。

> Vercel の Hobby プランは Cron の実行回数・時刻の精度に制限があります。
> 時刻どおりの配信が必要な場合は Pro プラン以上をご検討ください。

うまく送られないときは、管理画面の「🛠 システム設定」→「🩺 リマインドの診断」で
翌日の予約が送信対象になっているかを確認できます。

---

## 6. ディレクトリ構成

```
supabase/
  schema.sql             テーブル・ビュー・関数・権限設定
  seed.sql               校舎マスタの初期データ

api/                     Vercel のサーバーレス関数(REST API)
  schools.js               GET  校舎マスタ
  slots.js                 GET  予約可能な枠(保護者向け)
  bookings.js              GET/POST/PATCH/DELETE 予約(保護者向け)
  admin/
    auth.js                ログイン・ログアウト・状態確認
    slots.js               枠の一覧・追加・更新・削除(要ログイン)
    bookings.js            予約の一覧・更新・キャンセル(要ログイン)
    export-calendar.js     月カレンダーのExcel出力(要ログイン)
    setup.js               通知先の設定・接続確認・リマインド診断(要ログイン)
  cron/
    reminders.js           前日リマインドの定期実行

lib/                     共通ロジック
  db.js                    Supabaseクライアント
  schools.js               校舎マスタ
  format.js                日付・時刻の正規化とタイムゾーン処理
  store.js                 予約・枠のドメインロジック
  mailer.js                メール送信(Resend / SMTP)
  notify.js                通知メールとリマインドの本文・送信
  auth.js                  管理画面の認証
  calendar-export.js       月カレンダーのExcel生成
  http.js                  APIハンドラ共通のヘルパー

public/                  画面(静的HTML)
  index.html               保護者用
  admin.html               職員用

scripts/
  import-from-xlsx.mjs   スプレッドシートからの移行

tests/                   テスト(npm test)
```

---

## 7. 開発

```bash
npm install
npm test                 # 100件のテストを実行(Supabaseへの接続は不要)

# ローカルで動かす場合
npm i -g vercel
cp .env.example .env.local   # 値を記入する
vercel dev
```

テストは Supabase クライアントをインメモリのモックに差し替えて、実際のAPIハンドラと
ドメインロジックをそのまま動かしています。`supabase/schema.sql` のDB関数
(`create_booking` など)と同じ挙動をモック側にも実装しているため、
接続情報がなくても実行できます。

---

## 8. 設計上のポイント

### 二重予約の防止
`create_booking` というDBの関数の中で、予約枠の行をロック(`SELECT ... FOR UPDATE`)してから
件数を数えて挿入します。同じ枠に同時に予約が来ても直列に処理されるため、定員を超えることはありません。
GAS版の `LockService` と同じ役割を、より確実な形で果たしています。

### タイムゾーン
Vercel のサーバーは UTC で動きます。「今日」「明日」「過去かどうか」の判定は
すべて `TIMEZONE`(既定 `Asia/Tokyo`)の壁時計を基準に計算しています。
日付と時刻は `date` 型・`time` 型で持ち(タイムゾーンを持たない)、
予約日時などの記録は `timestamptz` 型で持って表示時に日本時間へ直しています。

### アクセス制御
全テーブルでRLSを有効にし、ポリシーを1つも作っていません。
そのため `anon` キーからは何も見えず、`service_role` キーを持つサーバーだけが読み書きできます。
管理画面のAPIはさらに、署名付きCookieによるログイン確認を通ります。

### カレンダー出力
GAS版はGoogleドライブにスプレッドシートを作っていましたが、Googleの認証情報を使わない構成に
したため、同じ体裁のExcelファイル(.xlsx)を生成してブラウザにダウンロードさせる方式にしました。
ダウンロードしたファイルは Excel でも Googleスプレッドシート でも開けます。
