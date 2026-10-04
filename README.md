# すきおし

今期アニメの原作漫画・ラノベに、タップ1回で「すき」を投票できるランキングサイト。
「すきなもの おしえて」

- 画面：HTML / CSS / JavaScript（`scripts/build.mjs` が `data/` から全ページを作る）
- 投票の受付：Cloudflare Pages Functions（`functions/`）
- 投票の保存：Cloudflare D1（`schema.sql`）
- 表紙画像：楽天ブックス書籍検索API（キーはサーバー側だけに置く）

## フォルダの中身

| 場所 | 中身 |
|---|---|
| `data/site.json` | サイト名、URL、お問い合わせ先、AdSenseの設定 |
| `data/seasons.json` | シーズン（投票期間、対象作品、期・クール） |
| `data/works.json` | 作品（タイトル、漫画/ラノベ、楽天の検索語、紹介文） |
| `public/` | CSS・JS・画像など、そのまま公開するファイル |
| `functions/api/` | 投票・ランキング・表紙・週間投稿文のサーバー処理 |
| `scripts/build.mjs` | ページを作るスクリプト（Cloudflareが自動で実行） |
| `scripts/local-test.mjs` | 手元での動作確認（自動テスト） |
| `schema.sql` | D1データベースの表の作り方 |

## 公開する手順（Cloudflare Pages）

1. **GitHubにアップ**：このフォルダの中身を `Hirochan12/sukioshi` に入れる
2. **D1を作る**：Cloudflare管理画面 →「ストレージとデータベース」→「D1」→「データベースを作成」→ 名前 `sukioshi`
   - 作ったD1の「コンソール」に `schema.sql` の中身を貼り付けて実行
3. **Pagesを作る**：「Workers & Pages」→「作成」→「Pages」→「Gitに接続」→ `sukioshi` を選ぶ
   - プロジェクト名：`sukioshi`
   - ビルドコマンド：`node scripts/build.mjs`
   - ビルド出力ディレクトリ：`dist`
4. **D1をつなぐ**：Pagesプロジェクト →「設定」→「バインディング」→「追加」→ D1データベース
   - 変数名：`DB` ／ データベース：`sukioshi`
5. **環境変数を入れる**：「設定」→「変数とシークレット」
   | 名前 | 種類 | 中身 |
   |---|---|---|
   | `SITE_URL` | テキスト | `https://sukioshi.pages.dev`（独自ドメインにしたら変更） |
   | `RAKUTEN_APP_ID` | シークレット | 楽天のアプリID |
   | `RAKUTEN_ACCESS_KEY` | シークレット | 楽天のアクセスキー |
   | `RAKUTEN_AFFILIATE_ID` | シークレット | 楽天アフィリエイトID |
   | `ADMIN_KEY` | シークレット | 週間投稿ページの合言葉（自分で決める長めの文字列） |
   | `HASH_SALT` | シークレット | IPアドレスを隠すための鍵（自分で決める長めの文字列） |
6. **もう一度デプロイ**：「デプロイ」タブ → 最新のデプロイの「…」→「再試行」

プロジェクト名が取られていて `sukioshi.pages.dev` にならなかった場合は、
`data/site.json` の `url`、環境変数 `SITE_URL`、楽天の「許可されたWebサイト」の3か所を実際のアドレスに合わせてください。

## ふだんの運用

### 新しいシーズンを始める（年4回：1月・4月・7月・10月）
1. `data/works.json` に新しい作品を追加（`id` は `w134` のように続きの番号）
2. `data/seasons.json` の `seasons` に新しいシーズンを追加し、`current` を新しいシーズンのIDにする
   - 前のシーズンは消さない（過去シーズンとして残る）
   - 続編の作品は、前と同じ `id` を使うと作品ページに順位の推移が並ぶ
3. GitHubに上げると自動で公開される。前のシーズンは `voteEnd` を過ぎると自動で締め切り

### 週間ランキングをXに投稿する
`/admin/weekly/` を開き、合言葉（`ADMIN_KEY`）を入れて「集計する」→ 投稿文を確認・修正 →「Xで投稿する」。

### 作品の紹介文を書く（AdSense審査に必要）
`data/works.json` の `intro` に HTML で書く（例：`"<p>…</p><p>…</p>"`）。
目安は300文字以上。公式サイトやほかのサイトの文章はコピーしない。

## AdSense 申請前のチェックリスト
- [ ] 独自ドメインを取得して設定した（`site.json` の `url` と `SITE_URL` も変更）
- [ ] `site.json` にお問い合わせ先（`contactEmail` か `contactFormUrl` か `xAccount`）を入れた
- [ ] 人気上位30作品くらいに紹介文（`intro`）を書いた
- [ ] 各シーズンページに「原作まとめ」記事（`seasons.json` の `article`）を書いた
- [ ] Google Search Console にサイトを登録し、`/sitemap.xml` を送信した
- [ ] 審査に通ったら `site.json` の `adsenseClient`（`ca-pub-…`）を入れる → `ads.txt` も自動で作られる
- [ ] 広告ユニットを作ったら `site.json` の `adSlots` にユニットIDを入れる（空なら自動広告のみ）

## 手元での確認
```
node scripts/build.mjs        # ページを作る
npm test                      # 自動テスト（投票・集計・制限・ページ・リンク切れ）
node --experimental-sqlite scripts/local-test.mjs --serve   # http://localhost:8788 で表示確認
```
手元の確認では楽天APIは偽のデータを使います。
