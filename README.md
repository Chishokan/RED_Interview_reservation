# 面談予約システム (Vercel + Supabase版)

Google Apps Script (GAS) で動いていた面談予約システムを、**Vercel で動く Web アプリ**に移行したものです。
データは **Supabase (PostgreSQL)** に保存します。

## 部門ごとにURLが分かれています

RED部門と中等部は、保護者・職員のどちらから見ても**別々のサービスとして表示されます**。
データベースは1つですが、画面・URL・ログイン・通知先はすべて部門ごとに分かれています。

| | RED部門 | 中等部 |
|---|---|---|
| 保護者用 | `https://<プロジェクト名>.vercel.app/red` | `https://<プロジェクト名>.vercel.app/chutobu` |
| 管理画面 | `.../red/admin` | `.../chutobu/admin` |
| 基調色 | 青 | 緑 |
| 学年の選択肢 | 小1〜高3 | 小4〜中3 |
| 新規予約の通知 | メール | LINE WORKS |

`/`(ルート)は部門を選ぶ画面です。保護者の方には各部門の直接のURLをご案内してください。

**部門をまたいだ操作はできません。** ある部門でログインしても別部門の管理APIは使えず、
保護者が同じメールアドレスを使っていても、自部門の予約しか表示されません。

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
| 部門の分離 | スプレッドシートを分ける | 1つのDBで部門ごとにURL・ログインを分離 |
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
3. 続けて `supabase/seed.sql` を貼り付けて実行する(部門と校舎の初期データ)

どちらも**何度実行しても安全**です。すでに稼働中のデータベースに対して実行しても、
既存の予約は保持したまま不足しているテーブルや列だけが追加されます。

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
| `ADMIN_ID_RED` / `ADMIN_PASSWORD_RED` 等 | 部門ごとの管理画面ログイン。部門別の値が無ければ `ADMIN_ID` / `ADMIN_PASSWORD` を使う |
| `SESSION_SECRET` | ログインCookieの署名鍵。`openssl rand -base64 32` などで生成した長いランダムな文字列(24文字以上。どこかから取得する値ではなく、自分で作ります) |
| `CRON_SECRET` | リマインドの定期実行を外部から勝手に叩かれないようにするトークン |

メール送信は `RESEND_API_KEY`(推奨)か、`SMTP_HOST` などのSMTP設定のどちらかを入れてください。
**どちらも未設定の場合、メールは送信されずログに記録されるだけ**になります(予約自体は正常に動きます)。

中等部のLINE WORKS通知を使う場合は、`LINE_WORKS_*` の5つを設定したうえで、
管理画面の「システム設定」から校舎ごとにトークルームIDを入力してください。
未設定でも予約機能は正常に動き、LINE WORKSへの通知だけが送られない状態になります。

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
# --dept でどの部門のデータかを指定します(red / chutobu)
npm run import:xlsx -- ./RED部門.xlsx --dept red --dry-run   # まず件数だけ確認
npm run import:xlsx -- ./RED部門.xlsx --dept red             # 実際に取り込む
npm run import:xlsx -- ./中等部.xlsx  --dept chutobu
```

**接続情報を用意せずに移行したい場合**は、`--sql` でSQLファイルを書き出し、
SupabaseのSQL Editorに貼り付けて実行することもできます。

```bash
npm run import:xlsx -- ./中等部.xlsx --dept chutobu --sql ./migrate.sql
```

> ⚠️ 書き出したSQLには保護者・お子様の氏名やメールアドレスが含まれます。
> Gitにコミットせず、実行後は削除してください。

取り込まれるもの:

- 「通知先」シート → 校舎マスタの通知先アドレス(RED部門のみ)
- 「〇〇予約枠」シート → 予約枠(日付・時刻・ラベル・公開・定員)
- 「〇〇予約データ」シート → 予約(予約IDをそのまま引き継ぐので、**何度実行しても重複しません**)

> 中等部の「日野校」「大野校」は、RED部門の「RED日野教室」「RED大野教室」と
> GAS版では同じ校舎ID(`hino` / `ono`)でした。データベースを共有するため、
> 中等部側は `chutobu_hino` / `chutobu_ono` というIDに変えて取り込みます。

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
  departments.js           GET  部門マスタ(部門の選択画面用)
  schools.js               GET  校舎マスタ(部門ごと)
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
  schools.js               部門マスタと校舎マスタ
  lineworks.js             LINE WORKSへの通知
  format.js                日付・時刻の正規化とタイムゾーン処理
  store.js                 予約・枠のドメインロジック
  mailer.js                メール送信(Resend / SMTP)
  notify.js                通知メールとリマインドの本文・送信
  auth.js                  管理画面の認証
  calendar-export.js       月カレンダーのExcel生成
  http.js                  APIハンドラ共通のヘルパー

public/                  画面(静的HTML)
  index.html               部門の選択画面(/)
  booking.html             保護者用(/<部門>)
  admin.html               職員用(/<部門>/admin)

scripts/
  import-from-xlsx.mjs   スプレッドシートからの移行

tests/                   テスト(npm test)
```

---

## 7. 開発

```bash
npm install
npm test                 # 130件のテストを実行(Supabaseへの接続は不要)

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

### 部門の分離
すべてのAPIが部門を必須の引数として受け取り、指定された校舎がその部門のものかを毎回確認します。
校舎を引く関数は**部門の指定が無ければ何も返さない**(閉じる側に倒す)ので、
渡し忘れが他部門のデータに触れる抜け道になりません。
ログインCookieも部門ごとに分かれており、中に部門名が署名付きで入っているため、
ある部門のCookieを別部門で使い回すことはできません。

### カレンダー出力
GAS版はGoogleドライブにスプレッドシートを作っていましたが、Googleの認証情報を使わない構成に
したため、同じ体裁のExcelファイル(.xlsx)を生成してブラウザにダウンロードさせる方式にしました。
ダウンロードしたファイルは Excel でも Googleスプレッドシート でも開けます。
