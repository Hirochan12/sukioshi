// すきおし サイト生成スクリプト
// data/*.json と public/ から、公開用のファイル一式を dist/ に作る。
// Cloudflare Pages のビルドコマンド: node scripts/build.mjs  （出力先: dist）
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'dist');
const readJson = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

const site = readJson('data/site.json');
const { current: CURRENT, seasons } = readJson('data/seasons.json');
const works = readJson('data/works.json');
const tags = readJson('data/tags.json');
const workById = new Map(works.map((w) => [w.id, w]));
// 全作品のジャンル（data/genres.json）
const GENRE_DATA = existsSync(join(ROOT, 'data/genres.json')) ? readJson('data/genres.json') : { genres: [], works: {} };
const GENRE_BY_ID = new Map(GENRE_DATA.genres.map((g) => [g.id, g]));
const genresOf = (id) => (GENRE_DATA.works[id] || []).map((gid) => GENRE_BY_ID.get(gid)).filter(Boolean);
const ATTRS = existsSync(join(ROOT, 'data/attrs.json')) ? readJson('data/attrs.json') : { items: [], levels: [], works: {} };
const SITE_URL = (process.env.SITE_URL || site.url).replace(/\/$/, '');
const BUILD_DATE = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

// ---- 入力チェック（間違いがあればビルドを止める） ----
const problems = [];
const seenIds = new Set();
for (const w of works) {
  if (seenIds.has(w.id)) problems.push(`作品IDが重複: ${w.id}`);
  seenIds.add(w.id);
  if (!['manga', 'novel', 'game', 'original', 'other'].includes(w.type)) problems.push(`種類が不正: ${w.id} ${w.type}`);
}
for (const s of seasons) {
  if (s.id !== 'recommend' && !/^\d{4}-(winter|spring|summer|autumn)$/.test(s.id)) problems.push(`シーズンIDの形が不正: ${s.id}`);
  if (!(s.voteStart <= s.voteEnd)) problems.push(`投票期間が不正: ${s.id}`);
  for (const e of s.works) if (!workById.has(e.workId)) problems.push(`${s.id} に存在しない作品: ${e.workId}`);
}
if (!seasons.some((s) => s.id === CURRENT)) problems.push(`current のシーズンがない: ${CURRENT}`);
if (problems.length) {
  console.error('データに問題があります:\n- ' + problems.join('\n- '));
  process.exit(1);
}

// ---- 小さな道具 ----
const esc = (s = '') =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const creditLine = (w) => {
  const m = w.magazine || '';
  const p = w.publisher || '';
  if (!m && !p) return '';
  const label = m ? (w.type === 'manga' ? '掲載誌' : 'レーベル') : isBook(w) ? '出版社' : '制作';
  const text = m && p ? `${m}（${p}）` : m || p;
  return `\n      <p class="work-credit">${label}：${esc(text)}</p>`;
};
const ALL_TYPES = ['manga', 'novel', 'game', 'original', 'other'];
const TYPE_LABEL = { manga: '漫画', novel: '小説/ライトノベル', game: 'ゲーム', original: 'オリジナル', other: 'その他' };
const isBook = (w) => w.type === 'manga' || w.type === 'novel';
// 作品ページや見出しで使う言い方（漫画・小説は従来どおり）
const TYPE_TAG = { manga: '漫画原作', novel: '小説/ライトノベル原作', game: 'ゲーム原作', original: 'オリジナルアニメ', other: 'その他の原作' };
const ORIGIN_NAME = { manga: '原作漫画', novel: '原作小説/ライトノベル', game: '原作ゲーム', original: 'オリジナルアニメ', other: 'アニメ' };
const typesIn = (list) => ALL_TYPES.filter((t) => list.some((w) => w.type === t));
const typeChips = (attr, types) => types.map((t) => `    <button type="button" class="chip" ${attr}="${t}" aria-pressed="false">${TYPE_LABEL[t]}</button>`).join('\n');
const MAX_TAGS = 3;
const TAG_GROUPS = [['story', '作品の魅力'], ['anime', 'アニメの魅力']];
function tagChipsHtml() {
  return TAG_GROUPS.map(([g, label]) => `    <p class="tag-group-label">${label}</p>
    <div class="tag-chips">
${tags.filter((t) => t.group === g).map((t) => `      <button type="button" class="tag-chip" data-tag-pick="${t.id}" aria-pressed="false">${esc(t.label)}</button>`).join('\n')}
    </div>`).join('\n');
}

const plain = (html) => String(html || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
const clip = (t, n) => (t.length > n ? t.slice(0, n - 1) + '…' : t);
const seasonsOf = (workId) => seasons.filter((s) => s.works.some((e) => e.workId === workId));
const noteOf = (season, workId) => season.works.find((e) => e.workId === workId)?.note || '';
const ordered = [...seasons].sort((a, b) => b.voteStart.localeCompare(a.voteStart) || b.id.localeCompare(a.id));
// アーカイブ: 年ごと(新しい年が先)→その年の中は冬・春・夏・秋の順。おすすめなど年のないものは最後にまとめる
const SEASON_ORDER = { winter: 0, spring: 1, summer: 2, autumn: 3 };
function archiveGroups() {
  const byYear = new Map();
  const rest = [];
  for (const s of seasons) {
    const m = /^(\d{4})-(winter|spring|summer|autumn)$/.exec(s.id);
    if (!m) { rest.push(s); continue; }
    if (!byYear.has(m[1])) byYear.set(m[1], []);
    byYear.get(m[1]).push(s);
  }
  const groups = [...byYear.keys()].sort((a, b) => b.localeCompare(a)).map((y) => ({
    title: `${y}年`,
    items: byYear.get(y).sort((a, b) => SEASON_ORDER[a.id.split('-')[1]] - SEASON_ORDER[b.id.split('-')[1]]),
  }));
  if (rest.length) groups.push({ title: 'そのほか', items: rest });
  return groups;
}
const currentSeason = seasons.find((s) => s.id === CURRENT);

// 作品ごとの主題歌（OP/ED）。works.json の songs（1行ずつのHTML）を使う
for (const w of works) if (w.intro) w.intro = w.intro.replace(/<p>運営者のおすすめ作品です。[^<]*<\/p>/, '');
// 運営者おすすめの理由を作品ページに出すための対応表（データは recommend.json の1か所だけ）
const REC = new Map();
if (existsSync(join(ROOT, 'data/recommend.json'))) {
  for (const g of readJson('data/recommend.json').genres) {
    for (const it of g.items) {
      if (!it.workId) continue;
      const list = REC.get(it.workId) || [];
      list.push({ genreId: g.id, genreName: g.name, paras: it.paras });
      REC.set(it.workId, list);
    }
  }
}
// 運営者の感想文の表示スイッチ（false の間は作品ページとおすすめページに感想を出さない。データは recommend.json に残す）
const SHOW_REC_COMMENTS = false;
const recHtml = (id) => {
  if (!SHOW_REC_COMMENTS) return '';
  const seen = new Set();
  const parts = [];
  for (const r of REC.get(id)) {
    const ps = r.paras.filter((t) => !seen.has(t));
    ps.forEach((t) => seen.add(t));
    if (ps.length) parts.push(ps.map((t) => `<p>${esc(t)}</p>`).join(''));
  }
  if (!parts.length) return '';
  return `<h3>運営者のおすすめポイント</h3>${parts.join('')}<p class="fine"><a href="/recommend/">運営者おすすめの作品をもっと見る</a></p>`;
};
const SONGS = new Map(works.filter((w) => Array.isArray(w.songs) && w.songs.length).map((w) => [w.id, w.songs]));
const airText = (s) => (s.id === 'recommend' ? '過去の作品もふくむ' : `${s.months}放送`);
const openEnded = (s) => s.id === 'recommend' || s.voteEnd >= '2099-01-01';
const fmtPeriod = (s) => (openEnded(s) ? '期限なし（いつでも投票できます）' : `${fmtDate(s.voteStart)}〜${fmtDate(s.voteEnd)}`);
const fmtDate = (d) => {
  const [y, m, day] = d.split('-').map(Number);
  return `${y}年${m}月${day}日`;
};

function hashFile(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 8);
}

// ---- 共通レイアウト ----
function layout({ path, title, description, body, noindex = false, jsonLd = null, ogType = 'website' }) {
  const url = SITE_URL + path;
  const fullTitle = path === '/' ? `${site.name}｜${site.tagline} 今期アニメ原作の人気投票` : `${title}｜${site.name}`;
  const v = ASSET_VERSION;
  const adsense = site.adsenseClient
    ? `<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${esc(site.adsenseClient)}" crossorigin="anonymous"></script>`
    : '';
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(fullTitle)}</title>
<meta name="description" content="${esc(description)}">
${noindex ? '<meta name="robots" content="noindex, nofollow">' : `<link rel="canonical" href="${esc(url)}">`}
<meta property="og:site_name" content="${esc(site.name)}">
<meta property="og:type" content="${ogType}">
<meta property="og:title" content="${esc(fullTitle)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${SITE_URL}/assets/og.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#ffffff">
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/assets/style.css?v=${v}">
${jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>` : ''}
${adsense}
</head>
<body data-adsense="${esc(site.adsenseClient)}">
<a class="skip" href="#main">本文へ移動</a>
<header class="site-header">
  <div class="wrap header-inner">
    <a class="logo" href="/" aria-label="${esc(site.name)} トップへ"><span class="logo-heart" aria-hidden="true">♥</span>${esc(site.name)}</a>
    <nav class="nav" aria-label="メニュー">
      <a href="/">ランキング</a>
      <a href="/search/">さがす</a>
      <a href="/recommend/">おすすめ</a>
      <a href="/collection/">コレクション</a>
      <a href="/seasons/">アーカイブ</a>
      <a href="/about/">このサイトについて</a>
    </nav>
  </div>
</header>
<main id="main" class="wrap">
${body}
</main>
<footer class="site-footer">
  <div class="wrap">
    <nav class="footer-nav" aria-label="サイト情報">
      <a href="/about/">このサイトについて</a>
      <a href="/seasons/">アーカイブ</a>
      <a href="/database/">作品データベース</a>
      <a href="/criteria/">評価基準</a>
      <a href="/minna/">みんなのすき</a>
      <a href="/privacy/">プライバシーポリシー</a>
      <a href="/terms/">利用規約</a>
      <a href="/contact/">お問い合わせ</a>
    </nav>
    <p class="fine">当サイトは楽天アフィリエイトを利用しています。表紙画像と商品情報は楽天ブックスから提供されています。 <a href="https://webservice.rakuten.co.jp/" target="_blank" rel="noopener">Supported by Rakuten Developers</a></p>
    <p class="fine">&copy; ${new Date().getFullYear()} ${esc(site.name)}</p>
  </div>
</footer>
<button type="button" class="to-top" data-to-top aria-label="ページの一番上に戻る" hidden><span aria-hidden="true">↑</span></button>
<div class="toast" role="status" aria-live="polite" hidden></div>
<div class="sheet-backdrop" data-tag-sheet hidden>
  <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="tag-sheet-title">
    <p class="sheet-kicker" data-tag-sheet-work></p>
    <h2 id="tag-sheet-title" class="sheet-title">どこがすき？</h2>
    <p class="sheet-lead">おすすめポイントを${MAX_TAGS}つまで選んでください</p>
${tagChipsHtml()}
    <p class="form-error" data-tag-sheet-error hidden></p>
    <div class="sheet-share" data-sheet-share hidden>
      <span class="share-label">推しをみんなに広めよう</span>
      <a class="btn btn-share" data-sheet-share-x href="#" target="_blank" rel="noopener">Xでシェア</a>
      <a class="btn btn-line" data-sheet-share-line href="#" target="_blank" rel="noopener">LINEで送る</a>
    </div>
    <div class="sheet-actions">
      <button type="button" class="btn" data-tag-skip>あとで</button>
      <button type="button" class="btn btn-pink" data-tag-send>送る</button>
    </div>
  </div>
</div>
<script src="/assets/app.js?v=${v}" defer></script>
</body>
</html>
`;
}

function adSlot(name) {
  // 審査に通るまでは表示しない（app.js が adsenseClient のあるときだけ中身を入れる）
  return `<div class="ad-slot" data-ad-slot="${name}" hidden><span class="ad-label">広告</span></div>`;
}

// ---- ランキング部分 ----
const strongAttrs = (id) => {
  const a = ATTRS.works[id];
  return a ? ATTRS.items.filter((it) => (a.v[it.name] || 0) >= 4).map((it) => it.name).join(' ') : '';
};
function rankingSection(season, { headingTag = 'h2', heading } = {}) {
  const items = season.works
    .map(({ workId, note }) => {
      const w = workById.get(workId);
      return `<li class="rank-item" data-work="${w.id}" data-type="${w.type}" data-search-keys="${esc([w.title, w.searchKana || ''].join(' '))}"${strongAttrs(w.id) ? ` data-attrs="${esc(strongAttrs(w.id))}"` : ''}>
  <span class="rank-no" aria-label="順位">–</span>
  <a class="cover" data-cover-link href="/works/${w.id}/" tabindex="-1" aria-hidden="true"><img data-cover="${w.id}" alt="" width="60" height="84" decoding="async"></a>
  <div class="rank-body">
    <a class="rank-title" href="/works/${w.id}/">${esc(w.title)}</a>
    <span class="rank-meta"><span class="tag tag-${w.type}">${TYPE_LABEL[w.type]}</span>${note ? `<span>${esc(note)}</span>` : ''}</span>
    <span class="rank-count"><span class="count" data-count>0</span> すき</span>
  </div>
  <button class="vote" type="button" data-vote data-season="${season.id}" data-work="${w.id}" aria-label="『${esc(w.title)}』にすきを送る"><span class="vote-heart" aria-hidden="true">♡</span><span class="vote-text">すき</span></button>
</li>`;
    })
    .join('\n');
  return `<section class="ranking" data-ranking data-season="${season.id}" data-vote-start="${season.voteStart}" data-vote-end="${season.voteEnd}" aria-labelledby="rk-${season.id}">
  <${headingTag} id="rk-${season.id}" class="ranking-heading">${esc(heading || `${season.label}原作ランキング`)}</${headingTag}>
  <p class="vote-period" data-period-note>投票期間：${fmtPeriod(season)}</p>
  <div class="tabs" role="tablist" aria-label="集計期間" data-period-tabs>
    <button type="button" role="tab" data-period="today" aria-selected="false">今日</button>
    <button type="button" role="tab" data-period="week" aria-selected="false">今週</button>
    <button type="button" role="tab" data-period="season" aria-selected="true">${esc(season.name)}ぜんぶ</button>
  </div>
  <div class="filters" role="group" aria-label="原作の種類">
    <button type="button" class="chip" data-type-filter="all" aria-pressed="true">すべて</button>
${typeChips('data-type-filter', typesIn(season.works.map((e) => workById.get(e.workId))))}
  </div>
${season.works.some((e) => ATTRS.works[e.workId]) ? `  <div class="tag-filter attr-filter" role="group" aria-label="属性で探す">
    <span class="tag-filter-label">属性で探す（運営者の評価が4以上）</span>
    <div class="tag-filter-row">
${ATTRS.items.map((it) => `      <button type="button" class="chip" style="--c:${it.color}" data-attr-filter="${it.name}" aria-pressed="false">${it.name}</button>`).join('\n')}
      <button type="button" class="chip" data-attr-clear hidden>選択を解除</button>
    </div>
    <p class="fine">評価済みの作品が対象です（${season.works.filter((e) => ATTRS.works[e.workId]).length}／${season.works.length}作品）。<a href="/criteria/">評価基準</a>・<a href="/database/">作品データベース</a></p>
  </div>
` : ''}  <div class="rank-search">
    <input type="search" class="search-input" data-rank-search placeholder="作品名でさがす（例：薬屋）" aria-label="このランキングの作品名でさがす" autocomplete="off" enterkeyhint="search">
  </div>
  <p class="rank-search-empty" data-rank-search-empty hidden>見つかりませんでした。<a href="/search/">すべてのシーズンからさがす</a></p>
  <p class="rank-status" data-rank-status>ランキングを読み込んでいます…</p>
  <ol class="rank-list" data-rank-list>
${items}
  </ol>
</section>`;
}

const pages = []; // { path, html, priority, noindex }
function addPage(path, html, { priority = 0.5, noindex = false } = {}) {
  pages.push({ path, html, priority, noindex });
}

// ---- トップページ ----

// ---- シェアボタン（X・LINE・リンクをコピー） ----
function shareBar(path, text, { label = 'シェアする' } = {}) {
  const url = `${SITE_URL}${path}`;
  const x = `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;
  const line = `https://social-plugins.line.me/lineit/share?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;
  return `<div class="share-bar" aria-label="${esc(label)}">
  <span class="share-label">${esc(label)}</span>
  <a class="btn btn-share" href="${x}" target="_blank" rel="noopener">Xでシェア</a>
  <a class="btn btn-line" href="${line}" target="_blank" rel="noopener">LINEで送る</a>
  <button type="button" class="btn" data-copy-url="${esc(url)}">リンクをコピー</button>
</div>`;
}

function buildIndex() {
  const event = seasons.find((s) => s.eventName && s.id !== CURRENT);
  const banner = event
    ? `<a class="event-banner" href="/season/${event.id}/" data-show-until="${event.voteEnd}">
  <span class="event-kicker">${openEnded(event) ? 'いつでも投票OK' : fmtDate(event.voteEnd) + 'まで'}</span>
  <span class="event-title">${esc(event.eventName)}</span>
  <span class="event-cta">投票する →</span>
</a>`
    : '';
  const body = `
<section class="top-search" data-top-search>
  <p class="ts-brand" aria-label="${esc(site.tagline)}"><span aria-hidden="true"><em>すき</em>なもの</span> <span aria-hidden="true"><em>おし</em>えて</span></p>
  <p class="ts-tagline">略して「すきおし」</p>
  <form class="ts-form" action="/search/" method="get" role="search">
    <input type="search" name="q" class="ts-input" data-ts-input placeholder="作品名でさがす" aria-label="アニメ原作を作品名でさがす" autocomplete="off" enterkeyhint="search">
    <button type="submit" class="ts-btn" aria-label="さがす">さがす</button>
    <ul class="ts-suggest" data-ts-suggest hidden></ul>
  </form>
  <p class="ts-links"><a href="/search/">すべての作品</a><a href="/songs/">主題歌から探す</a><a href="/quiz/">好みから診断</a><a href="/recommend/">おすすめ</a><a href="/database/">作品データベース</a><a href="/genre/">ジャンル別</a><a href="/seasons/">シーズンを選ぶ</a></p>
</section>
<section class="hero">
  <h1>${esc(currentSeason.label)}の原作、どれがすき？</h1>
  <p class="hero-lead">気になる作品の <span class="inline-heart">♡すき</span> をタップするだけ。1作品につき1日1回、いくつでも投票できます。</p>
</section>
${banner}
${rankingSection(currentSeason, { heading: `${currentSeason.label}原作 人気ランキング` })}
${shareBar('/', `${currentSeason.label}の原作、どれがすき？ 推しに「すき」を送ろう♡ #すきおし`, { label: 'このランキングをシェア' })}
${adSlot('top-bottom')}
<section class="section-links">
  <h2>シーズンを選ぶ</h2>
${archiveGroups().map((g) => `  <details class="archive-group"${g.items.some((s) => s.id === currentSeason.id) ? ' open' : ''}>
    <summary>${esc(g.title)}</summary>
    <ul class="archive-chips">
${g.items.map((s) => `      <li><a href="/season/${s.id}/"><span class="ac-name">${esc(s.id === 'recommend' ? '運営者おすすめ' : { winter: '冬', spring: '春', summer: '夏', autumn: '秋' }[s.id.split('-')[1]])}</span><span class="ac-meta">${s.works.length}作品</span></a></li>`).join('\n')}
    </ul>
  </details>`).join('\n')}
</section>`;
  addPage('/', layout({
    path: '/',
    title: '',
    description: site.description,
    body,
    jsonLd: { '@context': 'https://schema.org', '@type': 'WebSite', name: site.name, url: SITE_URL + '/', description: site.description },
  }), { priority: 1.0 });
}

// ---- シーズンページ ----
function seasonIntro(s) {
  const cnt = (t) => s.works.filter((e) => workById.get(e.workId).type === t).length;
  const parts = ALL_TYPES.filter((t) => cnt(t) > 0).map((t) => `${{ manga: '漫画が原作', novel: '小説/ライトノベルが原作', game: 'ゲームが原作', original: 'オリジナルアニメ', other: 'その他の原作' }[t]}の${cnt(t)}作品`);
  const partsText = parts.length > 1 ? `${parts.slice(0, -1).join('、')}と、${parts[parts.length - 1]}` : parts[0];
  const sequels = s.works.filter((e) => /期|Season|season|クール|STAGE/.test(e.note)).length;
  return `<p>${esc(s.label)}（${esc(airText(s))}）のうち、${partsText}を集めました。${sequels ? `そのうち${sequels}作品は、続編や2クール目の放送です。` : ''}</p>
<p>アニメを見て原作が気になった作品や、原作から追いかけている作品に「すき」を送ってください。票は1作品につき1日1回まで入れられ、毎日の積み重ねで順位が決まります。</p>`;
}

const genreGrid = (genres) => `<ul class="genre-grid">${genres.map((g) => `<li><a class="btn" href="/recommend/${g.id}/"><span>${esc(g.name)}</span><small>${g.items.length}作品</small></a></li>`).join('')}</ul>`;
const REC_GENRES = existsSync(join(ROOT, 'data/recommend.json')) ? readJson('data/recommend.json').genres : [];

function buildSeason(s) {
  const isEvent = Boolean(s.eventName);
  const h1 = isEvent ? s.eventName : `${s.label}の原作 人気ランキング`;
  const desc = isEvent
    ? `${s.label}（${airText(s)}）の原作漫画・小説/ライトノベル${s.works.length}作品から、いちばん「すき」な作品を選ぶ振り返り投票。${openEnded(s) ? 'いつでも' : fmtDate(s.voteEnd) + 'まで'}投票できます。`
    : `${s.label}（${airText(s)}）の原作漫画・小説/ライトノベル${s.works.length}作品の人気ランキング。タップ1回で「すき」を投票でき、今日・今週・シーズン全体の順位が見られます。`;
  const body = `
<nav class="crumbs" aria-label="パンくずリスト"><a href="/">トップ</a><span aria-hidden="true">›</span><a href="/seasons/">アーカイブ</a><span aria-hidden="true">›</span><span>${esc(s.name)}</span></nav>
<article class="season-article">
  <h1>${esc(h1)}</h1>
  <div class="prose">
${seasonIntro(s)}

  </div>
</article>
${s.id === 'recommend' && REC_GENRES.length ? `<section class="genre-pick"><h2>ジャンルから選ぶ</h2>${genreGrid(REC_GENRES)}</section>` : ''}
${rankingSection(s, { heading: isEvent ? '投票・ランキング' : `${s.label}原作ランキング` })}
${shareBar(`/season/${s.id}/`, `${isEvent ? s.eventName : `${s.label}の原作 人気ランキング`} 推しに「すき」を送ろう♡ #すきおし`, { label: 'このランキングをシェア' })}
${s.article ? `<details class="season-more"><summary>${esc(s.label)}の原作まとめを読む</summary><div class="prose">${s.article}</div></details>` : ''}
${adSlot('season-bottom')}
<p class="back-link"><a href="/seasons/">アーカイブでほかのシーズンを見る</a></p>`;
  const pageTitle = isEvent ? h1 : `${s.label}の原作 人気ランキング｜漫画・小説/ライトノベル${s.works.length}作品一覧`;
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'ItemList',
        name: `${s.label}の原作漫画・小説/ライトノベル`,
        numberOfItems: s.works.length,
        itemListElement: s.works.map((e, i) => ({ '@type': 'ListItem', position: i + 1, name: workById.get(e.workId).title, url: `${SITE_URL}/works/${e.workId}/` })),
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'トップ', item: SITE_URL + '/' },
          { '@type': 'ListItem', position: 2, name: 'アーカイブ', item: `${SITE_URL}/seasons/` },
          { '@type': 'ListItem', position: 3, name: s.name, item: `${SITE_URL}/season/${s.id}/` },
        ],
      },
    ],
  };
  addPage(`/season/${s.id}/`, layout({ path: `/season/${s.id}/`, title: pageTitle, description: desc, body, jsonLd }), { priority: s.id === CURRENT ? 0.9 : 0.7 });
}

function buildSeasonList() {
  const body = `
<nav class="crumbs" aria-label="パンくずリスト"><a href="/">トップ</a><span aria-hidden="true">›</span><span>アーカイブ</span></nav>
<h1>アーカイブ</h1>
<p>アニメの放送シーズンごとに、原作の人気ランキングを残しています。投票期間が終わったシーズンも、最終順位をいつでも見られます。</p>
${archiveGroups().map((g) => `<h2 class="archive-year">${esc(g.title)}</h2>
<ul class="season-table">
${g.items
  .map(
    (s) => `  <li data-season-row data-vote-start="${s.voteStart}" data-vote-end="${s.voteEnd}">
    <a href="/season/${s.id}/"><span class="st-name">${esc(s.eventName || s.label + '原作ランキング')}</span>
    <span class="st-meta">${esc(airText(s))}・${s.works.length}作品・投票 ${fmtPeriod(s)}</span>
    <span class="st-status" data-season-status></span></a>
  </li>`
  )
  .join('\n')}
</ul>`).join('\n')}`;
  addPage('/seasons/', layout({ path: '/seasons/', title: 'アーカイブ', description: 'すきおしのアニメ放送シーズンのアーカイブ。各シーズンの原作漫画・小説/ライトノベルの人気ランキングと最終順位を見られます。', body }), { priority: 0.6 });
}


// ---- さがすページ（全シーズンの作品から検索） ----
function buildSearch() {
  const list = works
    .filter((w) => seasonsOf(w.id).length)
    .map((w) => {
      const ss = seasonsOf(w.id).sort((a, b) => b.voteStart.localeCompare(a.voteStart));
      const keys = [w.title, w.rakutenQuery || '', w.searchKana || ''].join(' ');
      return `  <li class="search-item" data-search-keys="${esc(keys)}" data-type="${w.type}">
    <a href="/works/${w.id}/"><span class="si-title">${esc(w.title)}</span>
    <span class="si-meta"><span class="tag tag-${w.type}">${TYPE_LABEL[w.type]}</span>${ss.map((s) => `<span>${esc(s.label)}${noteOf(s, w.id) ? `（${esc(noteOf(s, w.id))}）` : ''}</span>`).join('')}</span></a>
  </li>`;
    })
    .join('\n');
  const body = `
<nav class="crumbs" aria-label="パンくずリスト"><a href="/">トップ</a><span aria-hidden="true">›</span><span>さがす</span></nav>
<h1>アニメ・原作をさがす</h1>
<p>すきおしにのっている、すべてのシーズンのアニメ原作（漫画・小説/ライトノベル）から作品名でさがせます。ひらがな・カタカナどちらでも大丈夫です。ジャンルから探したいときは<a href="/genre/">ジャンル別一覧</a>へどうぞ。</p>
<div class="site-search" data-site-search>
  <input type="search" class="search-input search-input-large" data-site-search-input placeholder="作品名を入力（例：スライム、薬屋）" aria-label="作品名でさがす" autocomplete="off" enterkeyhint="search">
  <div class="filters" role="group" aria-label="原作の種類">
    <button type="button" class="chip" data-search-type="all" aria-pressed="true">すべて</button>
${typeChips('data-search-type', typesIn(works.filter((w) => seasonsOf(w.id).length)))}
  </div>
  <p class="rank-status" data-site-search-status aria-live="polite"></p>
  <ul class="search-list">
${list}
  </ul>
</div>`;
  addPage('/search/', layout({ path: '/search/', title: 'アニメ・原作をさがす', description: 'すきおしにのっているアニメ原作の漫画・小説/ライトノベルを作品名でさがせます。今のシーズンも過去のシーズンも検索できます。', body }), { priority: 0.5 });
}

// ---- 主題歌からさがすページ（紹介文のオープニング・エンディングの記載から作る） ----
function buildSongs() {
  const rows = [];
  for (const w of works) {
    if (!seasonsOf(w.id).length || !w.intro) continue;
    const paras = String(w.intro).split('</p>').map((x) => x.replace(/<[^>]+>/g, '').trim()).filter(Boolean);
    const songs = [];
    for (const para of paras) {
      for (const sent of para.split('。')) {
        if (/(オープニング|エンディング|主題歌|挿入歌)(は|を|も)/.test(sent) && /「/.test(sent)) songs.push(sent.trim() + '。');
      }
    }
    if (songs.length) rows.push({ w, songs });
  }
  const list = rows
    .map(({ w, songs }) => {
      const ss = seasonsOf(w.id).sort((a, b) => b.voteStart.localeCompare(a.voteStart));
      const keys = [w.title, w.searchKana || '', ...songs].join(' ');
      return `  <li class="search-item" data-search-keys="${esc(keys)}" data-type="${w.type}">
    <a href="/works/${w.id}/"><span class="si-title">${esc(w.title)}</span>
    <span class="si-meta"><span class="tag tag-${w.type}">${TYPE_LABEL[w.type]}</span>${ss.slice(0, 1).map((s) => `<span>${esc(s.label)}</span>`).join('')}</span>
    <span class="si-songs">${songs.map((x) => esc(x)).join('')}</span></a>
  </li>`;
    })
    .join('\n');
  const body = `
<nav class="crumbs" aria-label="パンくずリスト"><a href="/">トップ</a><span aria-hidden="true">›</span><span>主題歌からさがす</span></nav>
<h1>主題歌からアニメ・原作をさがす</h1>
<p>すきおしにのっている${rows.length}作品の、オープニング・エンディングなどの主題歌を一覧にしました。曲名やアーティスト名を入力すると、その曲が使われている作品がみつかります（例：LiSA、unravel）。</p>
<div class="site-search" data-site-search>
  <input type="search" class="search-input search-input-large" data-site-search-input placeholder="曲名・アーティスト名を入力（例：LiSA、unravel）" aria-label="主題歌でさがす" autocomplete="off" enterkeyhint="search">
  <p class="rank-status" data-site-search-status aria-live="polite"></p>
  <ul class="search-list">
${list}
  </ul>
</div>
<p class="fine">主題歌の情報は、各作品ページの紹介文にのせているものです。作品名でさがしたいときは<a href="/search/">作品名検索</a>へどうぞ。</p>`;
  addPage('/songs/', layout({ path: '/songs/', title: '主題歌からアニメ・原作をさがす', description: `アニメのオープニング・エンディングの曲名やアーティスト名から、原作の漫画・小説/ライトノベルがあるアニメ${rows.length}作品をさがせます。`, body }), { priority: 0.5 });
}

// ---- 好みから探す診断（属性の評価から、気分に合う作品をえらぶ） ----
function buildQuiz() {
  if (!ATTRS.items.length) return;
  const LABEL = { 友情: '仲間との友情', 努力: '努力・修行', 勝利: '勝負・目標達成', 恋愛: 'ドキドキの恋愛', 青春: '学園・青春', 感動: '泣ける・感動', ギャグ: '笑えるギャグ', ミステリー: '謎解き・ミステリー', 日常系: 'のんびり日常', ファミリー: '家族・ほのぼの', バトル: '手に汗にぎるバトル', シリアス: '重めのシリアス' };
  const rows = works
    .filter((w) => seasonsOf(w.id).length && ATTRS.works[w.id])
    .map((w) => [w.id, w.title, w.type, ATTRS.items.map((it) => ATTRS.works[w.id].v[it.name] || 0)]);
  const data = JSON.stringify({ items: ATTRS.items.map((it) => it.name), types: TYPE_LABEL, works: rows }).replace(/</g, String.fromCharCode(92) + 'u003c');
  const chips = ATTRS.items.map((it) => `      <button type="button" class="chip" style="--c:${it.color}" data-q-attr="${esc(it.name)}" aria-pressed="false">${esc(LABEL[it.name] || it.name)}</button>`).join('\n');
  const body = `
<nav class="crumbs" aria-label="パンくずリスト"><a href="/">トップ</a><span aria-hidden="true">›</span><span>好みから探す診断</span></nav>
<h1>好みから探す診断</h1>
<p>いま見たい（読みたい）気分を、3つまで選んでください。運営者がつけた${rows.length}作品の属性評価（<a href="/criteria/">評価基準</a>）から、合う作品を5つ選びます。</p>
<div class="quiz" data-quiz>
  <h2>1. どんな作品がいいですか？（3つまで）</h2>
  <div class="filters" role="group" aria-label="気分を選ぶ">
${chips}
  </div>
  <h2>2. 原作の種類</h2>
  <div class="filters" role="group" aria-label="原作の種類">
    <button type="button" class="chip" data-q-type="all" aria-pressed="true">どれでも</button>
${typeChips('data-q-type', typesIn(works.filter((w) => seasonsOf(w.id).length)))}
  </div>
  <p><button type="button" class="btn" data-q-go>診断する</button></p>
  <p class="rank-status" data-q-status aria-live="polite"></p>
  <ol class="quiz-result" data-q-result></ol>
</div>
<script type="application/json" id="quiz-data">${data}</script>
<script>
(function(){
  var root=document.querySelector('[data-quiz]');if(!root)return;
  var D=JSON.parse(document.getElementById('quiz-data').textContent);
  var attrs=[],type='all';
  var chips=root.querySelectorAll('[data-q-attr]');
  chips.forEach(function(b){b.addEventListener('click',function(){
    var n=b.getAttribute('data-q-attr'),i=attrs.indexOf(n);
    if(i>=0){attrs.splice(i,1)}else{if(attrs.length>=3)return;attrs.push(n)}
    chips.forEach(function(x){x.setAttribute('aria-pressed',String(attrs.indexOf(x.getAttribute('data-q-attr'))>=0))});
  })});
  var tchips=root.querySelectorAll('[data-q-type]');
  tchips.forEach(function(b){b.addEventListener('click',function(){
    type=b.getAttribute('data-q-type');
    tchips.forEach(function(x){x.setAttribute('aria-pressed',String(x===b))});
  })});
  root.querySelector('[data-q-go]').addEventListener('click',function(){
    var st=root.querySelector('[data-q-status]'),ol=root.querySelector('[data-q-result]');
    ol.textContent='';
    if(!attrs.length){st.textContent='気分を1つ以上えらんでください。';return}
    var idx=attrs.map(function(n){return D.items.indexOf(n)});
    var list=D.works.filter(function(w){return type==='all'||w[2]===type}).map(function(w){
      var s=0,hit=0;idx.forEach(function(i){s+=w[3][i];if(w[3][i]>=4)hit++});
      return {w:w,s:s,hit:hit};
    }).filter(function(r){return r.hit>0}).sort(function(a,b){return b.hit-a.hit||b.s-a.s||(a.w[0]<b.w[0]?-1:1)});
    var top=list.slice(0,5);
    if(!top.length){st.textContent='ぴったりの作品がみつかりませんでした。条件をへらしてためしてください。';return}
    st.textContent=list.length+'作品から、とくに合う'+top.length+'作品です。';
    top.forEach(function(r){
      var li=document.createElement('li'),a=document.createElement('a');
      a.href='/works/'+r.w[0]+'/';a.textContent=r.w[1];
      var sm=document.createElement('small');sm.textContent=' （'+D.types[r.w[2]]+'）';
      li.appendChild(a);li.appendChild(sm);ol.appendChild(li);
    });
  });
})();
</script>`;
  addPage('/quiz/', layout({ path: '/quiz/', title: '好みから探す診断｜気分に合うアニメ原作', description: `いま見たい気分を選ぶだけで、${rows.length}作品の属性評価から、合うアニメ原作の漫画・小説/ライトノベルを5つえらびます。`, body }), { priority: 0.5 });
}

// ---- ジャンルの解説（ジャンルページに表示） ----
const GENRE_GUIDE = {
 "isekai": [
  [
   "の魅力",
   "異世界ものは、現代日本とは別の世界を舞台にした物語です。転生や転移で主人公が新しい世界に行き、その世界のルールの中で生きていきます。強い力を手に入れて成り上がる話もあれば、のんびりと暮らしを作っていく話、貴族社会や聖女の立場から物語が始まる話もあり、読みたい気分に合わせて選びやすいのが魅力です。"
  ],
  [
   "の選び方のコツ",
   "まず「戦う話」か「暮らす話」かで選ぶと外れにくくなります。冒険や魔王討伐が好きなら剣と魔法のバトル寄りの作品、ほっとしたいなら田舎暮らしや料理、育成を描く作品が向いています。悪役令嬢や聖女が主人公の作品は、恋愛と人間関係の駆け引きが中心になることが多いです。"
  ],
  [
   "を原作から楽しむと",
   "異世界ものは小説投稿サイト発の小説が多く、アニメでは描ききれない設定や心の声が原作に細かく書かれています。アニメで気になった作品は、原作の小説や漫画版を読むと、世界観がぐっと深く分かります。"
  ],
  [
   "はこんな人におすすめ",
   "ふだんの生活から少し離れて、物語の世界に入り込みたい人におすすめです。長く続くシリーズも多いので、気に入った作品に出会えると、長く楽しめます。"
  ]
 ],
 "battle": [
  [
   "の魅力",
   "バトル・アクションは、戦いの迫力と、そこに込められた登場人物の思いを楽しむジャンルです。能力を使った頭脳戦、格闘、剣と魔法の戦いなど、戦い方に作品ごとの個性が出ます。強い相手に仲間と挑む熱さや、ダークな世界観の緊張感が味わえます。"
  ],
  [
   "の選び方のコツ",
   "「熱血・王道」「頭脳戦・能力バトル」「ダーク・シリアス」「笑えるバトル」のどれが好きかを考えると選びやすくなります。王道は努力と友情が軸になり、ダークな作品は敵や世界の成り立ちが丁寧に描かれます。ギャグが混ざった作品は、戦いが苦手な人でも入りやすいです。"
  ],
  [
   "を原作から楽しむと",
   "バトル作品は、アニメの映像と音で迫力を楽しむことができる一方、原作の漫画ではコマ割りや絵の細部で戦いの流れをじっくり追えます。先の展開が気になったときに、原作で続きを読めるのも強みです。"
  ],
  [
   "はこんな人におすすめ",
   "手に汗にぎる展開が好きな人や、成長する主人公を応援したい人におすすめです。まずは気になる作品の1話分だけでも触れると、好みかどうかが分かります。"
  ]
 ],
 "love": [
  [
   "の魅力",
   "恋愛・ラブコメは、人と人との距離が近づいていく過程を楽しむジャンルです。幼なじみ、学園、大人の恋、ファンタジーの世界の恋愛など、舞台はさまざまですが、気持ちのすれ違いやドキドキする瞬間が共通の魅力です。"
  ],
  [
   "の選び方のコツ",
   "甘い展開が好きか、じれったい関係が好きか、コメディを交えたものが好きかで選ぶと合う作品に出会いやすくなります。ラブコメは笑いが多く気軽に楽しめ、純愛ものは感情の描写をじっくり味わえます。"
  ],
  [
   "を原作から楽しむと",
   "恋愛作品は、登場人物の気持ちを文章や吹き出しで細かく追える原作に魅力があります。アニメで気になった場面の「この時、何を思っていたのか」を、原作で確かめる楽しみ方もあります。"
  ],
  [
   "はこんな人におすすめ",
   "キャラクター同士の関係を見守りたい人や、気分が明るくなる作品を探している人におすすめです。"
  ]
 ],
 "comedy": [
  [
   "の魅力",
   "コメディ・日常は、笑える会話やゆるやかな毎日を楽しむジャンルです。テンポのよいギャグ、個性的なキャラクターのやりとり、学校や職場、家の中のささいな出来事など、大きな事件がなくても楽しめます。"
  ],
  [
   "の選び方のコツ",
   "「声を出して笑いたい」ならギャグ中心の作品、「ほっとしたい」なら日常系の作品が向いています。短い話が続く作品は、少しずつ見たり読んだりしたいときに便利です。"
  ],
  [
   "を原作から楽しむと",
   "ギャグは、アニメの間やテンポで笑える場面が多い一方、原作の漫画では、コマの中に細かい小ネタが入っていることがあります。日常系は、読み返すたびに気づくことがあります。"
  ],
  [
   "はこんな人におすすめ",
   "仕事や勉強の合間に気軽に楽しみたい人や、重い物語から少し離れたいときにおすすめです。"
  ]
 ],
 "mystery": [
  [
   "の魅力",
   "ミステリー・サスペンスは、謎が少しずつ明かされる過程を楽しむジャンルです。事件の犯人を推理する話、頭脳戦、デスゲーム、ホラー要素を含んだ話など、先が気になって続きを知りたくなる作品が多くあります。"
  ],
  [
   "の選び方のコツ",
   "「推理して楽しみたい」か「ハラハラしたい」かで選ぶと合う作品が見つかります。謎解き重視の作品は伏線が丁寧に張られ、サスペンスやデスゲームは展開の速さと緊張感が魅力です。"
  ],
  [
   "を原作から楽しむと",
   "ミステリーは、原作の文章や構図を自分のペースで読み返せるので、伏線を確認する楽しみがあります。アニメで結末を知ったあとに原作を読むと、細かい手がかりに気づけます。"
  ],
  [
   "はこんな人におすすめ",
   "考えながら楽しみたい人や、先の展開が気になって止まらなくなる作品を探している人におすすめです。"
  ]
 ],
 "horror": [
  [
   "の魅力",
   "ホラーは、幽霊や妖怪、怪異といった、日常の外にあるものと向き合う物語です。ぞくっとする怖さを楽しめる作品から、笑えるホラーコメディ、切なさのある怪異の話まで幅があります。"
  ],
  [
   "の選び方のコツ",
   "怖さが苦手な人は、コメディが混ざった作品や、妖怪が人間とかかわる心あたたまる作品から入ると楽しみやすくなります。しっかり怖い作品は、夜に1人で見ないほうがよい場合もあります。"
  ],
  [
   "を原作から楽しむと",
   "ホラーは、原作の漫画では絵の迫力や静けさで怖さを感じさせる作品が多く、アニメとはまた違う空気を味わえます。小説は、文章から想像する怖さが魅力です。"
  ],
  [
   "はこんな人におすすめ",
   "ひんやりとした空気が好きな人や、不思議な話が好きな人におすすめです。"
  ]
 ],
 "sports": [
  [
   "の魅力",
   "スポーツ作品は、勝利を目指す人たちの努力と、仲間とのきずなを描くジャンルです。野球、サッカー、バスケ、バレーなど、競技ごとにルールや戦い方があり、試合の緊張感を楽しめます。"
  ],
  [
   "の選び方のコツ",
   "好きな競技から選ぶのもよいですが、競技を知らなくても楽しめる作品が多くあります。チームの成長を描く作品か、1人の選手の挑戦を描く作品かで、雰囲気が変わります。"
  ],
  [
   "を原作から楽しむと",
   "スポーツ作品の原作は、試合の流れをコマの連続で追える、漫画の表現が魅力です。アニメでは、動きや音による臨場感が加わるので、両方を比べるのも楽しみ方の1つです。"
  ],
  [
   "はこんな人におすすめ",
   "熱い試合を見たい人や、努力する姿に元気をもらいたい人におすすめです。"
  ]
 ],
 "youth": [
  [
   "の魅力",
   "青春・学園は、学校生活や部活、友情、将来への悩みなど、身近なテーマを描くジャンルです。大学生活や、バンド、芸術に打ち込む作品まで、成長していく姿が魅力です。"
  ],
  [
   "の選び方のコツ",
   "「仲間とがんばる話」か「静かな心の動きを描く話」かで選ぶと、合う作品が見つかります。部活ものは目標に向かって進む爽快感があり、日常ものは感情の細かな描写が魅力です。"
  ],
  [
   "を原作から楽しむと",
   "青春作品は、登場人物の気持ちを細かく描く原作で、アニメには入りきらない場面や心の声を楽しめます。"
  ],
  [
   "はこんな人におすすめ",
   "自分の学生時代を思い出したい人や、まっすぐな物語に触れたい人におすすめです。"
  ]
 ],
 "sf": [
  [
   "の魅力",
   "SFは、未来の世界や科学、宇宙、仮想世界などを舞台にした物語です。サイバーパンク、終末もの、ゲームの世界など、現実とは違う前提のなかで、人間とは何かを考えさせる作品もあります。"
  ],
  [
   "の選び方のコツ",
   "世界観の設定を楽しみたいか、ストーリーの展開を楽しみたいかで選ぶとよいです。設定が細かい作品は、少しずつ世界のルールを理解していく楽しさがあります。"
  ],
  [
   "を原作から楽しむと",
   "SF作品は、原作の小説や漫画に、設定の説明が細かく書かれていることがあります。アニメを見て気になった設定は、原作で確認できます。"
  ],
  [
   "はこんな人におすすめ",
   "想像力を広げたい人や、新しい世界観に出会いたい人におすすめです。"
  ]
 ],
 "tears": [
  [
   "の魅力",
   "「泣ける・感動」は、運営者が泣けると思った作品を、ジャンルとして集めたものです。友情や別れ、成長が描かれ、読み終えたあとや見終えたあとに、じんわりと心が動く作品が入っています。"
  ],
  [
   "の選び方のコツ",
   "泣ける作品は、悲しい話だけではありません。温かい気持ちになって涙が出る作品も多くあります。気持ちに余裕のある時間に、ゆっくり楽しむのがおすすめです。"
  ],
  [
   "を原作から楽しむと",
   "原作では、アニメの音楽や声がない分、自分のペースで気持ちを整理しながら読めます。場面を何度も読み返せるのも、原作ならではです。"
  ],
  [
   "はこんな人におすすめ",
   "気持ちを動かされる物語に出会いたい人や、心をリセットしたい人におすすめです。"
  ]
 ]
};
const GENRE_ATTR = {"battle": ["バトル"], "love": ["恋愛"], "comedy": ["ギャグ", "日常系"], "mystery": ["ミステリー"], "sports": ["勝利"], "youth": ["青春"], "tears": ["感動"]};
function genreGuideHtml(g, list) {
  const secs = (GENRE_GUIDE[g.id] || []).map(([h, t]) => `<h2>${esc(g.name)}${esc(h)}</h2>\n<p>${esc(t)}</p>`).join('\n');
  const names = GENRE_ATTR[g.id] || [];
  let top = '';
  if (names.length) {
    const rows = list
      .map((w) => { const a = ATTRS.works[w.id]; const hit = a ? names.filter((n) => (a.v[n] || 0) >= 4) : []; return { w, hit, score: a ? Math.max(...names.map((n) => a.v[n] || 0)) : 0 }; })
      .filter((r) => r.hit.length)
      .sort((a, b) => b.score - a.score || b.hit.length - a.hit.length || (a.w.id < b.w.id ? -1 : 1))
      .slice(0, 8);
    if (rows.length) top = `<h2>運営者の評価で「${esc(names.join('・'))}」が高い作品</h2>\n<p>運営者がつけた属性評価（<a href="/criteria/">評価基準</a>）で、${esc(names.join('・'))}が4以上の作品から、とくに高いものを${rows.length}作品選びました。</p>\n<ul class="guide-top">${rows.map((r) => `<li><a href="/works/${r.w.id}/">${esc(r.w.title)}</a>（${TYPE_LABEL[r.w.type]}）</li>`).join('')}</ul>`;
  }
  return secs + (top ? '\n' + top : '');
}

// ---- 作品ページ ----

// ---- 作品の属性（運営者の評価） ----
function radarSvg(v) {
  const N = ATTRS.items.length, cx = 150, cy = 140, R = 85;
  const pt = (i, r, k = R) => { const t = -Math.PI / 2 + (i * 2 * Math.PI) / N; return [(cx + Math.cos(t) * k * r / 5).toFixed(1), (cy + Math.sin(t) * k * r / 5).toFixed(1)]; };
  let g = '';
  for (let k = 1; k <= 5; k++) g += `<polygon points="${ATTRS.items.map((_, i) => pt(i, k).join(',')).join(' ')}" fill="none" stroke="#e7e5df" stroke-width="${k === 5 ? 1.4 : 1}"/>`;
  ATTRS.items.forEach((it, i) => {
    const [x, y] = pt(i, 5), [lx, ly] = pt(i, 5, R + 22);
    const anchor = lx < cx - 8 ? 'end' : lx > cx + 8 ? 'start' : 'middle';
    g += `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="#e7e5df"/><text x="${lx}" y="${(+ly + 4).toFixed(1)}" text-anchor="${anchor}" font-size="11" font-weight="700" fill="${it.color}">${it.name}</text>`;
  });
  const poly = ATTRS.items.map((it, i) => pt(i, v[it.name] || 0).join(',')).join(' ');
  g += `<polygon points="${poly}" fill="#d4537e" fill-opacity=".22" stroke="#d4537e" stroke-width="2"/>`;
  ATTRS.items.forEach((it, i) => { const [x, y] = pt(i, v[it.name] || 0); g += `<circle cx="${x}" cy="${y}" r="4" fill="${it.color}" stroke="#fff" stroke-width="1.5"/>`; });
  return `<svg class="attr-radar" viewBox="-30 0 360 285" role="img" aria-label="12項目の属性チャート">${g}</svg>`;
}
function attrHtml(w) {
  const a = ATTRS.works[w.id];
  if (!a) return '';
  const strong = ATTRS.items.filter((it) => (a.v[it.name] || 0) >= 4).sort((x, y) => a.v[y.name] - a.v[x.name]);
  const chips = strong.map((it) => `<span class="attr-chip" style="--c:${it.color}">${it.name} ${a.v[it.name]}</span>`).join('');
  const bars = ATTRS.items.filter((it) => a.c === 'n' || a.v[it.name] != null).map((it) => {
    const x = a.v[it.name] || 0;
    return `<li><span class="ab-l" style="color:${it.color}">${it.name}</span><span class="ab-t"><b style="width:${x * 20}%;background:${it.color}"></b></span><span class="ab-v">${x}</span></li>`;
  }).join('');
  return `<section class="work-attrs">
    <h2>作品の属性（運営者の評価）</h2>
    <p class="fine">各項目を0〜5で評価しています。基準は<a href="/criteria/">作品属性の評価基準</a>をご覧ください。${a.c === 's' ? '情報が十分に確認できた項目だけを載せています。' : ''}</p>
    ${a.c === 'n' ? radarSvg(a.v) : ''}
    ${chips ? `<p class="attr-chips">${chips}</p>` : ''}
    <ul class="attr-bars">${bars}</ul>
  </section>`;
}

// ---- 似ている作品（運営者の評価の近さ） ----
const ATTR_NAMES = ATTRS.items.map((it) => it.name);
const strongOf = (a) => new Set(ATTR_NAMES.filter((k) => (a.v[k] || 0) >= 4));
function attrScore(a, b) {
  const sa = strongOf(a);
  const sb = strongOf(b);
  const shared = [...sa].filter((k) => sb.has(k));
  const union = new Set([...sa, ...sb]).size;
  const jac = union ? shared.length / union : 0;
  if (a.c === 'n' && b.c === 'n') {
    const l1 = ATTR_NAMES.reduce((t, k) => t + Math.abs((a.v[k] || 0) - (b.v[k] || 0)), 0);
    return { score: 0.5 * jac + 0.5 * (1 - l1 / (ATTR_NAMES.length * 5)), shared };
  }
  if (!shared.length) return { score: 0, shared };
  return { score: Math.min(jac, 0.95) * 0.9, shared };
}
const SIMILAR_MIN = 0.4;
function similarWorks(w, limit = 3) {
  const out = [];
  const mine = ATTRS.works[w.id];
  if (mine) {
    const hits = [];
    for (const x of works) {
      const theirs = ATTRS.works[x.id];
      if (x.id === w.id || !theirs || !seasonsOf(x.id).length) continue;
      const { score, shared } = attrScore(mine, theirs);
      if (score >= SIMILAR_MIN) hits.push({ w: x, pct: Math.min(99, Math.round(score * 100)), why: shared.length ? `${shared.slice(0, 3).join('・')}が近い` : '全体の傾向が近い' });
    }
    hits.sort((a, b) => b.pct - a.pct || a.w.id.localeCompare(b.w.id));
    out.push(...hits.slice(0, limit));
  }
  if (out.length < limit) {
    const mineG = GENRE_DATA.works[w.id] || [];
    const used = new Set([w.id, ...out.map((o) => o.w.id)]);
    const hits = [];
    for (const x of works) {
      if (used.has(x.id) || !seasonsOf(x.id).length) continue;
      const common = (GENRE_DATA.works[x.id] || []).filter((g) => mineG.includes(g));
      if (common.length) hits.push({ w: x, pct: null, why: `同じ「${GENRE_BY_ID.get(common[0]).name}」`, n: common.length });
    }
    hits.sort((a, b) => b.n - a.n || (a.w.type === w.type ? -1 : 0) - (b.w.type === w.type ? -1 : 0) || a.w.id.localeCompare(b.w.id));
    out.push(...hits.slice(0, limit - out.length));
  }
  return out;
}
function similarSection(w) {
  const list = similarWorks(w);
  if (!list.length) return '';
  const hasPct = list.some((o) => o.pct !== null);
  return `<section class="similar">
    <h2>『${esc(w.title)}』に似ている作品</h2>
    <ul class="similar-list">
${list.map((o) => `      <li><a href="/works/${o.w.id}/"><span class="sm-main"><span class="sm-title">${esc(o.w.title)}</span><span class="sm-why">${esc(o.why)}</span></span>${o.pct !== null ? `<span class="sm-pct"><b>${o.pct}%</b>似てる</span>` : ''}</a></li>`).join('\n')}
    </ul>
    <p class="fine">${hasPct ? '似ている度は、運営者が付けた12項目の評価（<a href="/criteria/">評価基準</a>）の近さから計算しています。評価がまだない作品は、同じジャンルの作品を表示しています。' : '評価がまだない作品のため、同じジャンルの作品を表示しています。'}</p>
  </section>

  `;
}

function buildWork(w) {
  const ss = seasonsOf(w.id).sort((a, b) => b.voteStart.localeCompare(a.voteStart));
  const main = ss[0];
  const note = noteOf(main, w.id);
  const typeLong = TYPE_TAG[w.type];
  const desc = w.intro
    ? clip(`『${w.title}』の${ORIGIN_NAME[w.type]}はどんな話？ ${plain(w.intro)}`, 118)
    : `『${w.title}』は${main.label}にアニメが放送された${typeLong}の作品です。すきおしで今の順位を確認して、「すき」を投票できます。`;
  const related = main.works
    .filter((e) => e.workId !== w.id && workById.get(e.workId).type === w.type)
    .slice(0, 6)
    .map((e) => workById.get(e.workId));
  const makerKey = (x) => x.magazine || x.publisher || '';
  const sameMaker = makerKey(w)
    ? works.filter((x) => x.id !== w.id && x.type === w.type && makerKey(x) === makerKey(w)).slice(0, 5)
    : [];
  const share = `『${w.title}』がすき！ #すきおし`;
  const body = `
<nav class="crumbs" aria-label="パンくずリスト"><a href="/">トップ</a><span aria-hidden="true">›</span><a href="/season/${main.id}/">${esc(main.name)}</a><span aria-hidden="true">›</span><span>${esc(w.title)}</span></nav>
<article class="work" data-work-page="${w.id}">
  <div class="work-head">
    ${isBook(w) ? `<a class="work-cover" data-book-link href="#" rel="sponsored noopener" target="_blank" aria-label="楽天ブックスで見る"><img data-cover="${w.id}" data-cover-size="large" alt="${esc(w.title)}の表紙" width="150" height="210"></a>` : `<div class="work-cover no-image" aria-hidden="true"></div>`}
    <div class="work-info">
      <h1>${esc(w.title)}</h1>
      <p class="work-tags"><span class="tag tag-${w.type}">${typeLong}</span><span>${esc(main.label)}${note ? '・' + esc(note) : ''}</span></p>
      <p class="work-author" data-book-author hidden></p>${creditLine(w)}
      <div class="work-rank" data-work-rank data-season="${main.id}" data-vote-start="${main.voteStart}" data-vote-end="${main.voteEnd}">
        <span class="wr-label">${esc(main.name)}の順位</span>
        <span class="wr-value"><span data-wr-rank>–</span><small>位</small></span>
        <span class="wr-count"><span data-wr-count>0</span> すき</span>
      </div>
      <button class="vote vote-large" type="button" data-vote data-season="${main.id}" data-work="${w.id}" aria-label="『${esc(w.title)}』にすきを送る"><span class="vote-heart" aria-hidden="true">♡</span><span class="vote-text">すき</span></button>
      <p class="vote-closed-note" data-closed-note hidden>${esc(main.name)}の投票は終了しました。</p>
    </div>
  </div>

  <div class="work-actions">
${isBook(w) ? `    <a class="btn btn-rakuten" data-book-link href="#" rel="sponsored noopener" target="_blank">楽天ブックスで原作を見る</a>` : ''}
  </div>

  ${shareBar(`/works/${w.id}/`, share, { label: 'この作品をシェア' })}

  ${w.intro ? `<section class="prose work-intro"><h2>どんな作品？</h2>${w.intro}${REC.has(w.id) ? recHtml(w.id) : ''}${SONGS.has(w.id) ? `<h3>主題歌</h3><ul class="work-songs">${SONGS.get(w.id).map((t) => `<li>${t}</li>`).join('')}</ul>` : ''}</section>` : ''}

  ${attrHtml(w)}

  <section class="work-tags" data-work-tags data-season="${main.id}">
    <h2>みんなのおすすめポイント</h2>
    <p class="fine" data-work-tags-empty>まだ選ばれていません。「すき」を送ったあとに、おすすめポイントを選べます。</p>
    <ul class="tag-bars" data-work-tags-list></ul>
  </section>

  <section class="work-history">
    <h2>シーズンごとの順位</h2>
    <ul class="history-list">
${ss.map((s) => `      <li data-history data-season="${s.id}"><a href="/season/${s.id}/">${esc(s.label)}</a><span class="hl-note">${esc(noteOf(s, w.id))}</span><span class="hl-rank" data-hl-rank>–</span></li>`).join('\n')}
    </ul>
  </section>

  <section class="work-data">
    <h2>『${esc(w.title)}』の作品データ</h2>
    <dl class="data-list">
      <dt>種類</dt><dd>${typeLong}原作</dd>
${w.rakutenAuthor ? `      <dt>作者</dt><dd>${esc(w.rakutenAuthor)}</dd>\n` : ''}${w.magazine || w.publisher ? `      <dt>${w.magazine ? (w.type === 'manga' ? '掲載誌' : 'レーベル') : isBook(w) ? '出版社' : '制作'}</dt><dd>${esc(w.magazine && w.publisher ? `${w.magazine}（${w.publisher}）` : w.magazine || w.publisher)}</dd>\n` : ''}      <dt>アニメの放送</dt><dd>${main.id === 'recommend' ? '過去の作品もふくむ' : esc(main.label)}</dd>
      <dt>すきおしでの掲載</dt><dd>${ss.map((x) => `<a href="/season/${x.id}/">${esc(x.name)}</a>`).join('、')}</dd>
${genresOf(w.id).length ? `      <dt>ジャンル</dt><dd>${genresOf(w.id).map((g) => `<a href="/genre/${g.id}/">${esc(g.name)}</a>`).join('、')}</dd>\n` : ''}${sameMaker.length ? `      <dt>同じ${w.magazine ? (w.type === 'manga' ? '掲載誌' : 'レーベル') : '出版社'}の作品</dt><dd>${sameMaker.map((r) => `<a href="/works/${r.id}/">${esc(r.title)}</a>`).join('、')}</dd>\n` : ''}${REC.has(w.id) ? `      <dt>運営者おすすめ</dt><dd>${[...new Map(REC.get(w.id).map((r) => [r.genreId, r.genreName])).entries()].map(([id, n]) => `<a href="/recommend/${id}/">${esc(n)}</a>`).join('、')}</dd>\n` : ''}    </dl>
  </section>

  ${adSlot('work-bottom')}

  ${similarSection(w)}${related.length ? `<section class="related">
    <h2>${esc(main.label)}のほかの${typeLong}原作</h2>
    <ul class="related-list">
${related.map((r) => `      <li><a href="/works/${r.id}/">${esc(r.title)}</a></li>`).join('\n')}
    </ul>
    <p><a href="/season/${main.id}/">${esc(main.label)}のランキングをすべて見る</a></p>
  </section>` : ''}
</article>`;
  addPage(`/works/${w.id}/`, layout({
    path: `/works/${w.id}/`,
    title: `${w.title}の${ORIGIN_NAME[w.type]}｜${w.intro ? 'あらすじ・' : ''}人気順位`,
    description: desc,
    body,
    ogType: 'article',
    jsonLd: {
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'Book',
          '@id': `${SITE_URL}/works/${w.id}/#book`,
          name: w.title,
          genre: typeLong,
          inLanguage: 'ja',
          url: `${SITE_URL}/works/${w.id}/`,
          ...(w.rakutenAuthor ? { author: { '@type': 'Person', name: w.rakutenAuthor } } : {}),
          ...(w.intro ? { description: clip(plain(w.intro), 200) } : {}),
        },
        {
          '@type': 'BreadcrumbList',
          itemListElement: [
            { '@type': 'ListItem', position: 1, name: 'トップ', item: SITE_URL + '/' },
            { '@type': 'ListItem', position: 2, name: main.name, item: `${SITE_URL}/season/${main.id}/` },
            { '@type': 'ListItem', position: 3, name: w.title, item: `${SITE_URL}/works/${w.id}/` },
          ],
        },
      ],
    },
  }), { priority: 0.6 });
}

// ---- 固定ページ ----
function simplePage(path, title, description, inner, opts = {}) {
  const body = `
<nav class="crumbs" aria-label="パンくずリスト"><a href="/">トップ</a><span aria-hidden="true">›</span><span>${esc(title)}</span></nav>
<article class="prose page">
<h1>${esc(title)}</h1>
${inner}
</article>`;
  addPage(path, layout({ path, title, description, body, noindex: opts.noindex }), opts);
}

function contactHtml() {
  const parts = [];
  if (site.contactFormUrl) parts.push(`<p><a class="btn" href="${esc(site.contactFormUrl)}" target="_blank" rel="noopener">お問い合わせフォームを開く</a></p>`);
  if (site.contactEmail) parts.push(`<p>メール：<a href="mailto:${esc(site.contactEmail)}">${esc(site.contactEmail)}</a></p>`);
  if (site.xAccount) parts.push(`<p>X（旧Twitter）：<a href="https://x.com/${esc(site.xAccount)}" target="_blank" rel="noopener">@${esc(site.xAccount)}</a> のDM</p>`);
  if (!parts.length) {
    console.warn('注意: data/site.json に contactEmail / contactFormUrl / xAccount のどれかを入れてください（お問い合わせページ用）');
  }
  return parts.join('\n');
}

// ---- ジャンル別の作品一覧（全作品） ----
function buildGenres() {
  if (!GENRE_DATA.genres.length) return;
  const byGenre = new Map(GENRE_DATA.genres.map((g) => [g.id, works.filter((w) => (GENRE_DATA.works[w.id] || []).includes(g.id) && seasonsOf(w.id).length)]));
  const grid = `<ul class="genre-grid">${GENRE_DATA.genres.map((g) => `<li><a class="btn" href="/genre/${g.id}/"><span>${esc(g.name)}</span><small>${byGenre.get(g.id).length}作品</small></a></li>`).join('')}</ul>`;
  addPage('/genre/', layout({ path: '/genre/', title: 'ジャンル別にアニメ原作を探す', description: `すきおしにのっているアニメ原作の漫画・小説/ライトノベルを、${GENRE_DATA.genres.map((g) => g.name).join('・')}のジャンル別に探せます。`, body: `
<nav class="crumbs" aria-label="パンくずリスト"><a href="/">トップ</a><span aria-hidden="true">›</span><span>ジャンル</span></nav>
<article class="prose page">
<h1>ジャンル別にアニメ原作を探す</h1>
<p>すきおしにのっている、アニメ原作の漫画・小説/ライトノベルを、ジャンルごとにまとめました。1つの作品が、複数のジャンルに入っていることもあります。</p>
${grid}
<p class="fine">作品名で探したいときは<a href="/search/">さがす</a>、運営者が選んだ作品を見たいときは<a href="/recommend/">おすすめ</a>をどうぞ。</p>
</article>` }), { priority: 0.7 });
  for (const g of GENRE_DATA.genres) {
    const list = byGenre.get(g.id);
    const path = `/genre/${g.id}/`;
    const items = list.map((w) => `  <li class="search-item">
    <a href="/works/${w.id}/"><span class="si-title">${esc(w.title)}</span>
    <span class="si-meta"><span class="tag tag-${w.type}">${TYPE_LABEL[w.type]}</span>${w.magazine || w.publisher ? `<span>${esc(w.magazine && w.publisher ? `${w.magazine}（${w.publisher}）` : w.magazine || w.publisher)}</span>` : ''}</span></a>
  </li>`).join('\n');
    const others = GENRE_DATA.genres.filter((x) => x.id !== g.id);
    const body = `
<nav class="crumbs" aria-label="パンくずリスト"><a href="/">トップ</a><span aria-hidden="true">›</span><a href="/genre/">ジャンル</a><span aria-hidden="true">›</span><span>${esc(g.name)}</span></nav>
<article class="prose page">
<h1>${esc(g.name)}のアニメ原作（${list.length}作品）</h1>
<p>${esc(g.description)}</p>
${genreGuideHtml(g, list)}
<p>${typesIn(list).map((t) => `${TYPE_LABEL[t]}${list.filter((w) => w.type === t).length}作品`).join('、')}をのせています。気になった作品を開くと、あらすじや原作の情報を見て、「すき」を送れます。</p>
<ul class="search-list">
${items}
</ul>
<h2>ほかのジャンル</h2>
<ul class="genre-others">${others.map((x) => `<li><a href="/genre/${x.id}/">${esc(x.name)}</a></li>`).join('')}</ul>
</article>`;
    addPage(path, layout({ path, title: `${g.name}のアニメ原作 ${list.length}作品`, description: `${g.description}${list.length}作品を集めています。`, body }), { priority: 0.7 });
  }
}

// ---- 運営者おすすめ ----
function buildRecommend() {
  if (!existsSync(join(ROOT, 'data/recommend.json'))) return;
  const r = readJson('data/recommend.json');
  const crumbs = (last) => `<nav class="crumbs" aria-label="パンくずリスト"><a href="/">トップ</a><span aria-hidden="true">›</span>${last ? `<a href="/recommend/">${esc(r.title)}</a><span aria-hidden="true">›</span><span>${esc(last)}</span>` : `<span>${esc(r.title)}</span>`}</nav>`;
  const genreLinks = r.genres.map((g) => `<li><a href="/recommend/${g.id}/">${esc(g.name)}</a>（${g.items.length}作品）</li>`).join('\n');
  addPage('/recommend/', layout({ path: '/recommend/', title: r.title, description: r.description, body: `
${crumbs('')}
<article class="prose page">
<h1>${esc(r.title)}</h1>
<p>${esc(r.intro)}</p>
<h2>ジャンルから選ぶ</h2>
${genreGrid(r.genres)}
<p class="fine">運営者が選んだ作品以外も含む、すべての作品は<a href="/genre/">ジャンル別一覧</a>から探せます。</p>
</article>` }), { priority: 0.7 });
  for (const g of r.genres) {
    const path = `/recommend/${g.id}/`;
    const items = g.items.map((it) => {
      const w = it.workId && workById.get(it.workId);
      return `<div class="rec-item">
${w ? `<a class="work-cover" data-cover-link href="/works/${w.id}/" aria-label="${esc(it.title)}の表紙"><img data-cover="${w.id}" data-cover-size="large" alt="${esc(it.title)}の表紙" width="120" height="168"></a>` : ''}
<div class="rec-body">
<h2 id="${it.workId || ''}">${w ? `<a href="/works/${w.id}/">${esc(it.title)}</a>` : esc(it.title)}</h2>
${it.meta ? `<p class="fine">${esc(it.meta)}</p>` : ''}
${SHOW_REC_COMMENTS ? it.paras.map((t) => `<p>${esc(t)}</p>`).join('\n') : ''}
${w ? `<p><a class="btn" href="/works/${w.id}/">『${esc(it.title)}』に「すき」を送る</a></p>` : ''}
</div>
</div>`;
    }).join('\n');
    const others = r.genres.filter((x) => x.id !== g.id);
    const body = `
${crumbs(g.name)}
<article class="prose page">
<h1>運営者おすすめの${esc(g.name)}アニメ</h1>
<p>${esc(g.lead)}</p>
${items}
${others.length ? `<h2>ほかのジャンル</h2>\n<ul>${others.map((x) => `<li><a href="/recommend/${x.id}/">${esc(x.name)}</a></li>`).join('')}</ul>` : ''}
</article>`;
    addPage(path, layout({ path, title: `運営者おすすめの${g.name}アニメ`, description: g.description, body }), { priority: 0.7 });
  }
}

// ---- コレクション（「すき」を押した作品が、その人の端末にたまるページ） ----
let worksIndexUrl = '';
function buildCollection() {
  // ブラウザが作品名・種類・シーズン名を引くための一覧
  const index = {
    works: Object.fromEntries(works.map((w) => [w.id, [w.title, w.type]])),
    seasons: Object.fromEntries(ordered.map((s) => [s.id, s.name])),
  };
  const json = JSON.stringify(index);
  writeFileSync(join(OUT, 'assets/works-index.json'), json);
  const v = createHash('sha256').update(json).digest('hex').slice(0, 8);
  worksIndexUrl = `/assets/works-index.json?v=${v}`;
  const path = '/collection/';
  const body = `
<nav class="crumbs" aria-label="パンくずリスト"><a href="/">トップ</a><span aria-hidden="true">›</span><span>わたしのコレクション</span></nav>
<article class="page collection" data-collection data-index="/assets/works-index.json?v=${v}">
<h1>わたしのすきコレクション</h1>
<p class="col-lead">「すき」を押した作品が、ここにたまっていきます。ふえるほど、称号がもらえます。</p>
<div class="col-summary" data-col-summary hidden>
<p class="col-count"><strong data-col-count>0</strong><span>作品</span></p>
<p class="col-title" data-col-title></p>
<div class="col-progress" aria-hidden="true"><div class="col-bar" data-col-bar></div></div>
<p class="fine" data-col-next></p>
<ul class="col-badges" data-col-badges></ul>
<p><button type="button" class="btn btn-share" data-col-share>Xでシェア</button>　<a class="btn btn-pink" href="/me/">マイすきカードを作る</a></p>
</div>
<div class="tag-filter-row" data-col-filters hidden>
<button type="button" class="chip" data-col-type="all" aria-pressed="true">すべて</button>
${typeChips('data-col-type', typesIn(works.filter((w) => seasonsOf(w.id).length)))}
</div>
<div data-col-list></div>
<div class="col-empty" data-col-empty hidden>
<p>まだ作品がありません。作品の「すき」を押すと、ここに表紙がならびます。</p>
<p><a class="btn btn-pink" href="/">ランキングを見る</a>　<a class="btn" href="/recommend/">運営者おすすめを見る</a></p>
</div>
<p class="form-error" data-col-error hidden>作品の一覧を読みこめませんでした。時間をおいて、もう一度ひらいてください。</p>
<p class="fine">コレクションは、いま使っているこの端末のブラウザに保存されます。スマホとパソコンでは別々になり、ブラウザのデータを消すと消えます。</p>
</article>`;
  addPage(path, layout({
    path, title: 'わたしのすきコレクション',
    description: '「すき」を押した作品が、この端末にたまっていくコレクションページです。',
    body, noindex: true,
  }), { noindex: true });
}

// ---- マイすきカード（コレクションから5作品を選び、カードにして共有する。データは端末とURLだけで持つ） ----
function buildMe() {
  const path = '/me/';
  const body = `
<nav class="crumbs" aria-label="パンくずリスト"><a href="/">トップ</a><span aria-hidden="true">›</span><span>マイすきカード</span></nav>
<article class="page me" data-me data-index="${worksIndexUrl}">
<h1>わたしのすき5選</h1>
<div data-me-view hidden>
<p class="col-lead" data-me-view-lead></p>
<ol class="me-card" data-me-card></ol>
<p class="me-comment" data-me-comment hidden></p>
<p><a class="btn btn-pink" href="/me/?new=1">自分のカードも作る</a>　<a class="btn" href="/minna/">みんなのすきを見る</a></p>
</div>
<div data-me-edit hidden>
<p class="col-lead">「すき」を押した作品の中から、いちばん好きな5作品を選んでカードにできます。</p>
<div class="col-empty" data-me-empty hidden>
<p>まだコレクションに作品がありません。作品の「すき」を押すと、ここで選べるようになります。</p>
<p><a class="btn btn-pink" href="/">ランキングを見る</a>　<a class="btn" href="/recommend/">運営者おすすめを見る</a></p>
</div>
<div data-me-work>
<h2 class="me-h">1. 作品をえらぶ（5つまで）</h2>
<ul class="me-pick" data-me-pick></ul>
<h2 class="me-h">2. じゅんばんを決める</h2>
<p class="fine" data-me-sel-hint></p>
<ol class="me-card" data-me-sel></ol>
<h2 class="me-h">3. ひとこと（40文字まで・なくてもOK）</h2>
<p><input type="text" class="me-input" data-me-input maxlength="40" placeholder="例：全部推しです" autocomplete="off"> <span class="fine" data-me-len>0 / 40</span></p>
<div data-me-actions hidden>
<h2 class="me-h">4. シェアする</h2>
<p class="me-actions"><button type="button" class="btn btn-share" data-me-x>Xでシェア</button> <button type="button" class="btn" data-me-image>画像を保存</button> <button type="button" class="btn" data-me-copy>リンクをコピー</button></p>
<p class="fine">共有リンクには、えらんだ作品とひとことだけが入ります。保存や登録はいりません。画像は作品名とひとことだけで作られます（表紙は入りません）。</p>
<h2 class="me-h">5. みんなのすきに載せる（任意）</h2>
<p class="fine">載せると、このカードとひとことが<a href="/minna/">みんなのすき</a>に公開されます。名前・リンク・連絡先は書かないでください。いつでも取り下げられます。載せるには、先に作品の「すき」を1回以上押している必要があります。</p>
<p class="me-actions"><button type="button" class="btn btn-pink" data-me-pub>みんなのすきに載せる</button> <button type="button" class="btn" data-me-unpub hidden>取り下げる</button></p>
<p class="fine" data-me-pub-status role="status"></p>
</div>
</div>
</div>
<p class="form-error" data-me-error hidden>作品の一覧を読みこめませんでした。時間をおいて、もう一度ひらいてください。</p>
</article>`;
  addPage(path, layout({
    path, title: 'わたしのすき5選｜マイすきカード',
    description: 'すきな作品を5つ選んで、カードにして共有できます。',
    body, noindex: true,
  }), { noindex: true });
}

// ---- みんなのすき（公開されたマイすきカードの一覧。中身はブラウザがAPIから読み込む） ----
function buildMinna() {
  const path = '/minna/';
  const body = `
<nav class="crumbs" aria-label="パンくずリスト"><a href="/">トップ</a><span aria-hidden="true">›</span><span>みんなのすき</span></nav>
<article class="page minna" data-minna data-index="${worksIndexUrl}">
<h1>みんなのすき</h1>
<p class="col-lead">みんなが選んだ「すき5選」です。タップすると、カードを開けます。</p>
<p><a class="btn btn-pink" href="/me/">自分のカードを作る</a></p>
<div class="minna-list" data-minna-list></div>
<p class="col-empty" data-minna-empty hidden>まだカードがありません。いちばん乗りで載せてみませんか？</p>
<p><button type="button" class="btn" data-minna-more hidden>もっと見る</button></p>
<p class="form-error" data-minna-error hidden>読みこめませんでした。時間をおいて、もう一度ひらいてください。</p>
<p class="fine">ひとことは利用者が書いたもので、運営者が内容を保証するものではありません。不適切なカードは「通報」を押してください。複数の通報で自動的に非表示になります。</p>
</article>`;
  addPage(path, layout({
    path, title: 'みんなのすき｜すき5選カード',
    description: 'みんなが選んだ「すき5選」カードの一覧です。',
    body, noindex: true,
  }), { noindex: true });
}


function buildDatabase() {
  const ids = Object.keys(ATTRS.works).filter((id) => workById.has(id));
  const rows = ids.map((id) => {
    const w = workById.get(id), a = ATTRS.works[id];
    const cells = ATTRS.items.map((it) => { const x = a.v[it.name]; return x == null ? '<td class="dn">–</td>' : `<td${x >= 4 ? ` class="dh" style="--c:${it.color}"` : ''}>${x}</td>`; }).join('');
    return `<tr><th scope="row"><a href="/works/${id}/">${esc(w.title)}</a><small>${TYPE_TAG[w.type]}${a.c === 's' ? '・一部のみ' : ''}</small></th>${cells}</tr>`;
  }).join('');
  const head = ATTRS.items.map((it) => `<th scope="col" style="color:${it.color}">${it.name}</th>`).join('');
  simplePage('/database/', '作品データベース', '今期アニメの原作漫画・小説/ライトノベルを、友情・努力・恋愛・バトルなど12項目で評価した一覧表です。', `
<p>作品を12の項目で0〜5に評価した一覧です。4以上の項目は色つきで示しています。評価は運営者によるもので、基準は<a href="/criteria/">作品属性の評価基準</a>にまとめています。「–」は、情報が十分に確認できず評価していない項目です。</p>
<div class="db-wrap"><table class="db-table"><thead><tr><th scope="col">作品</th>${head}</tr></thead><tbody>${rows}</tbody></table></div>
<p class="fine">現在は${ids.length}作品を掲載しています。順次追加します。</p>`, { priority: 0.6 });
}
function buildCriteria() {
  simplePage('/criteria/', '作品属性の評価基準', '作品ページや作品データベースに載せている、12項目の属性の評価基準と付け方を説明します。', `
<p>すきおしでは、作品を12の項目で0〜5に評価しています。これは運営者による主観的な評価で、作品の優劣を示すものではありません。公式サイト、出版社・書店の紹介ページ、公開されているあらすじを確認して付けています。</p>
<h2>0〜5の意味</h2>
<ul>${ATTRS.levels.map((t, i) => `<li><strong>${i}</strong>：${t}</li>`).join('')}</ul>
<p>5は1作品につき2項目まで、4以上は4項目までを目安にしています。</p>
<h2>12項目の定義</h2>
<dl class="info-list">${ATTRS.items.map((it) => `<dt style="color:${it.color}">${it.name}</dt><dd>${it.def}</dd>`).join('')}</dl>
<h2>似ている作品の「似てる度」</h2>
<p>作品ページの「似ている作品」は、12項目の評価の近さから計算しています。12項目すべてを評価した作品どうしは、項目ごとの差の小ささと、強い項目（4以上）の重なりを半分ずつ合わせた値です。一部の項目だけ評価した作品は、強い項目の重なりだけで計算し、上限を90%未満にしています。数字は目安で、作品の優劣を表すものではありません。</p>
<h2>情報が少ない作品について</h2>
<p>調べても内容が十分に確認できない作品は、チャートを出さず、確認できた強い項目だけを載せています。確認できていない項目を0とはしません。</p>
<p>評価は、新しい情報が分かった場合などに見直します。お気づきの点は<a href="/contact/">お問い合わせ</a>からお知らせください。</p>
<p><a href="/database/">作品データベースを見る</a></p>`, { priority: 0.5 });
}

function buildStatic() {
  simplePage('/about/', 'このサイトについて', 'すきおしは、今期アニメの原作漫画・小説/ライトノベルにタップで「すき」を投票できるランキングサイトです。運営者情報と投票の数え方を説明します。', `
<p>すきおしは、放送中のアニメの<strong>原作の漫画・小説/ライトノベル</strong>に「すき」を送って、いまどの作品が好かれているかを見られるサイトです。アニメを見て原作が気になったときの作品選びや、推しの作品を応援する場所として使ってください。</p>
<h2>投票の数え方</h2>
<ul>
<li>「すき」は、1つの作品につき1台の端末から1日1回まで送れます。日付は日本時間の0時に切り替わります。</li>
<li>いくつの作品に投票してもかまいません。</li>
<li>ランキングは「今日」「今週（直近7日間）」「シーズン全体」の3つの期間で見られます。</li>
<li>短い時間に大量の票が集中した場合など、不自然な票は数えないことがあります。</li>
<li>シーズンの投票期間が終わると投票は締め切り、そのときの順位が最終順位になります。</li>
</ul>
<h2>対象になる作品</h2>
<p>そのシーズンに放送されるテレビアニメ・配信アニメのうち、原作が漫画または小説/ライトノベルの作品を対象にしています。映画、オリジナルアニメ、ゲームが原作の作品は対象外です。</p>
<h2>表紙画像と商品リンク</h2>
<p>表紙画像と商品情報は、楽天ブックスのデータを使って表示しています。商品リンクから購入された場合、運営者が楽天アフィリエイトの紹介料を受け取ることがあります。ランキングの順位は投票だけで決まり、紹介料によって変わることはありません。</p>
<h2>運営者情報</h2>
<dl class="info-list">
<dt>サイト名</dt><dd>${esc(site.name)}</dd>
<dt>運営者</dt><dd>${esc(site.operator)}</dd>
<dt>開設日</dt><dd>${fmtDate(site.establishedDate)}</dd>
<dt>お問い合わせ</dt><dd><a href="/contact/">お問い合わせページ</a></dd>
</dl>`, { priority: 0.4 });

  simplePage('/privacy/', 'プライバシーポリシー', 'すきおしのプライバシーポリシー。投票で扱う情報、Cookie、広告、アクセス解析、アフィリエイトについて説明します。', `
<p>${esc(site.operator)}（以下「運営者」）は、${esc(site.name)}（以下「当サイト」）での情報の取り扱いを次のとおり定めます。</p>
<h2>投票で扱う情報</h2>
<p>同じ端末からの重複投票を防ぐため、投票時に次の情報を記録します。</p>
<ul>
<li>端末ごとにランダムに作るID（Cookieに保存します）</li>
<li>IPアドレスをもとに作った、元に戻せない符号（ハッシュ値）。IPアドレスそのものは保存しません。符号の作り方は日ごとに変わります。</li>
<li>投票した作品と日時</li>
</ul>
<p>これらは投票の集計と不正な投票の防止だけに使い、個人を特定する目的では使いません。お名前やメールアドレスなどの入力は求めていません。</p>
<h2>「みんなのすき」に載せた内容</h2>
<p>マイすきカードを「みんなのすき」に載せた場合に限り、えらんだ作品と、あなたが書いたひとことをサーバーに保存し、みんなに公開します。名前・連絡先などの入力は求めておらず、書かないでください。取り下げると削除されます。載せるのを選ばなければ、保存されません。</p>
<h2>Cookieとブラウザへの保存</h2>
<p>当サイトは、上記の端末IDのほか、投票済みの表示などのためにブラウザの保存領域を使います。ブラウザの設定でCookieを無効にできますが、その場合は投票できないことがあります。</p>
<h2>広告について</h2>
<p>当サイトは、第三者配信の広告サービス「Google アドセンス」を利用する予定、または利用しています。広告配信事業者は、利用者の興味に応じた広告を表示するためにCookieを使うことがあります。Googleによる広告でのCookieの使い方は<a href="https://policies.google.com/technologies/ads?hl=ja" target="_blank" rel="noopener">Googleのポリシーと規約</a>で確認できます。パーソナライズ広告は<a href="https://adssettings.google.com/" target="_blank" rel="noopener">広告設定</a>で無効にできます。</p>
<h2>アフィリエイトについて</h2>
<p>当サイトは楽天アフィリエイトに参加しています。商品リンクから楽天のサイトに移動して購入された場合、運営者が紹介料を受け取ることがあります。購入に関する情報は楽天グループ株式会社が取り扱い、運営者が購入者を特定することはありません。</p>
<h2>アクセス解析について</h2>
<p>当サイトはCloudflareの仕組みを使って公開しており、表示速度の改善や攻撃からの保護のために、アクセスの記録が自動で処理されることがあります。</p>
<h2>情報の第三者への提供</h2>
<p>法令にもとづく場合を除き、当サイトが記録した情報を第三者に提供することはありません。</p>
<h2>このポリシーの変更</h2>
<p>このポリシーは必要に応じて変更し、このページでお知らせします。</p>
<p class="fine">制定日：${fmtDate(site.privacyUpdated)}</p>`, { priority: 0.3 });

  simplePage('/terms/', '利用規約', 'すきおしの利用規約。投票のルール、禁止事項、免責事項を定めています。', `
<p>この規約は、${esc(site.name)}（以下「当サイト」）を使うときのルールです。当サイトを利用した時点で、この規約に同意したものとします。</p>
<h2>投票のルール</h2>
<ul>
<li>投票は1つの作品につき1台の端末から1日1回までです。</li>
<li>プログラムを使った自動投票、端末IDを消して何度も投票すること、たくさんの端末を使って特定の作品に票を集めることは禁止します。</li>
<li>不正と判断した票は、予告なく集計から外すことがあります。</li>
</ul>
<h2>禁止事項</h2>
<ul>
<li>当サイトの運営をさまたげる行為</li>
<li>当サイトの内容を、出典を示さずに転載する行為</li>
<li>法令や公序良俗に反する行為</li>
</ul>
<h2>免責事項</h2>
<ul>
<li>ランキングは利用者の投票を集計したもので、作品の評価や売上を表すものではありません。</li>
<li>作品情報や商品情報は正確になるよう努めていますが、内容を保証するものではありません。商品の価格や在庫は、移動先の楽天ブックスで確認してください。</li>
<li>当サイトの利用で生じた損害について、運営者は責任を負いません。</li>
<li>当サイトの内容は、予告なく変更・終了することがあります。</li>
</ul>
<h2>作品の権利について</h2>
<p>作品名、表紙画像などの権利は、それぞれの権利者に帰属します。表紙画像は楽天ブックスのデータを利用規約に沿って表示しています。権利者の方で掲載に問題がある場合は、<a href="/contact/">お問い合わせ</a>からご連絡ください。</p>
<p class="fine">制定日：${fmtDate(site.termsUpdated)}</p>`, { priority: 0.3 });

  simplePage('/contact/', 'お問い合わせ', 'すきおしへのお問い合わせ方法。対象作品の追加の要望、不具合の報告、掲載に関するご連絡を受け付けています。', `
<p>対象作品の追加や修正の要望、不具合の報告、掲載に関するご連絡は、次の方法で受け付けています。返信まで数日いただくことがあります。</p>
${contactHtml()}
<h2>よくある質問</h2>
<h3>見たいアニメの原作が載っていません</h3>
<p>原作が漫画または小説/ライトノベルのアニメを対象にしています。対象のはずの作品が見つからないときは、作品名を添えてご連絡ください。</p>
<h3>投票ボタンが押せません</h3>
<p>その作品には今日すでに投票しているか、シーズンの投票期間が終わっている可能性があります。日本時間の0時を過ぎると、また投票できます。</p>`, { priority: 0.3 });

  // 運営者用ページ（検索に載せない）
  addPage('/admin/weekly/', layout({
    path: '/admin/weekly/',
    title: '週間ランキング投稿（運営者用）',
    description: '運営者用ページ',
    noindex: true,
    body: `
<h1>週間ランキング投稿</h1>
<p class="fine">運営者用のページです。合言葉（Cloudflareに設定した ADMIN_KEY）を入れると、先週の集計とXへの投稿文ができます。</p>
<form class="admin-form" data-admin-form>
  <label>合言葉 <input type="password" name="key" autocomplete="current-password" required></label>
  <label>シーズン
    <select name="season">
${ordered.map((s) => `      <option value="${s.id}"${s.id === CURRENT ? ' selected' : ''}>${esc(s.label)}</option>`).join('\n')}
    </select>
  </label>
  <button class="btn" type="submit">集計する</button>
  <p class="form-error" data-admin-error hidden></p>
</form>
<div data-admin-result hidden>
  <h2 data-admin-title></h2>
  <ol data-admin-top></ol>
  <p data-admin-riser></p>
  <div data-admin-posts></div>
</div>`,
  }), { noindex: true });

  writeFileSync(join(OUT, '404.html'), layout({
    path: '/404',
    title: 'ページが見つかりません',
    description: 'お探しのページは見つかりませんでした。',
    noindex: true,
    body: `<article class="prose page"><h1>ページが見つかりません</h1><p>URLが変わったか、ページがなくなった可能性があります。</p><p><a class="btn" href="/">ランキングを見る</a></p></article>`,
  }));
}

// ---- 実行 ----
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
cpSync(join(ROOT, 'public'), OUT, { recursive: true });
const ASSET_VERSION = hashFile(join(ROOT, 'public/assets/style.css')).slice(0, 4) + hashFile(join(ROOT, 'public/assets/app.js')).slice(0, 4);

buildIndex();
buildSeasonList();
buildSearch();
buildSongs();
buildQuiz();
buildGenres();
for (const s of seasons) buildSeason(s);
for (const w of works) if (seasonsOf(w.id).length) buildWork(w);
buildStatic();
buildDatabase();
buildCriteria();
buildRecommend();
buildCollection();
buildMe();
buildMinna();

for (const p of pages) {
  const dir = join(OUT, p.path);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), p.html);
}

// サイトマップ・robots.txt・ads.txt
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages
  .filter((p) => !p.noindex)
  .map((p) => `  <url><loc>${SITE_URL}${p.path}</loc><lastmod>${BUILD_DATE}</lastmod><priority>${p.priority.toFixed(1)}</priority></url>`)
  .join('\n')}
</urlset>
`;
writeFileSync(join(OUT, 'sitemap.xml'), sitemap);
writeFileSync(join(OUT, 'robots.txt'), `User-agent: *\nAllow: /\nDisallow: /admin/\nDisallow: /api/\n\nSitemap: ${SITE_URL}/sitemap.xml\n`);
if (site.adsenseClient) {
  const pub = site.adsenseClient.replace(/^ca-/, '');
  writeFileSync(join(OUT, 'ads.txt'), `google.com, ${pub}, DIRECT, f08c47fec0942fa0\n`);
}
// ブラウザ用の設定（JSが使う公開情報だけ）
writeFileSync(
  join(OUT, 'assets/config.json'),
  JSON.stringify({ adsenseClient: site.adsenseClient, adSlots: site.adSlots || {}, siteUrl: SITE_URL, tags, maxTags: MAX_TAGS }, null, 0)
);

console.log(`生成しました: ${pages.length + 1} ページ（作品 ${works.length}、シーズン ${seasons.length}）→ dist/`);
