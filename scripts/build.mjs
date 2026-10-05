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
const SITE_URL = (process.env.SITE_URL || site.url).replace(/\/$/, '');
const BUILD_DATE = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

// ---- 入力チェック（間違いがあればビルドを止める） ----
const problems = [];
const seenIds = new Set();
for (const w of works) {
  if (seenIds.has(w.id)) problems.push(`作品IDが重複: ${w.id}`);
  seenIds.add(w.id);
  if (!['manga', 'novel'].includes(w.type)) problems.push(`種類が不正: ${w.id} ${w.type}`);
}
for (const s of seasons) {
  if (!/^\d{4}-(winter|spring|summer|autumn)$/.test(s.id)) problems.push(`シーズンIDの形が不正: ${s.id}`);
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
const TYPE_LABEL = { manga: '漫画', novel: 'ラノベ' };
const MAX_TAGS = 3;
const TAG_GROUPS = [['story', '作品の魅力'], ['anime', 'アニメの魅力']];
function tagChipsHtml() {
  return TAG_GROUPS.map(([g, label]) => `    <p class="tag-group-label">${label}</p>
    <div class="tag-chips">
${tags.filter((t) => t.group === g).map((t) => `      <button type="button" class="tag-chip" data-tag-pick="${t.id}" aria-pressed="false">${esc(t.label)}</button>`).join('\n')}
    </div>`).join('\n');
}

const TYPE_LONG = { manga: '漫画', novel: 'ライトノベル' };
const TYPE_SHORT = { manga: '漫画', novel: 'ラノベ' };
const plain = (html) => String(html || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
const clip = (t, n) => (t.length > n ? t.slice(0, n - 1) + '…' : t);
const seasonsOf = (workId) => seasons.filter((s) => s.works.some((e) => e.workId === workId));
const noteOf = (season, workId) => season.works.find((e) => e.workId === workId)?.note || '';
const ordered = [...seasons].sort((a, b) => b.voteStart.localeCompare(a.voteStart) || b.id.localeCompare(a.id));
const currentSeason = seasons.find((s) => s.id === CURRENT);
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
      <a href="/seasons/">シーズン</a>
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
      <a href="/seasons/">シーズン一覧</a>
      <a href="/privacy/">プライバシーポリシー</a>
      <a href="/terms/">利用規約</a>
      <a href="/contact/">お問い合わせ</a>
    </nav>
    <p class="fine">当サイトは楽天アフィリエイトを利用しています。表紙画像と商品情報は楽天ブックスから提供されています。</p>
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
function rankingSection(season, { headingTag = 'h2', heading } = {}) {
  const items = season.works
    .map(({ workId, note }) => {
      const w = workById.get(workId);
      return `<li class="rank-item" data-work="${w.id}" data-type="${w.type}" data-search-keys="${esc([w.title, w.searchKana || ''].join(' '))}">
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
  <p class="vote-period" data-period-note>投票期間：${fmtDate(season.voteStart)}〜${fmtDate(season.voteEnd)}</p>
  <div class="tabs" role="tablist" aria-label="集計期間" data-period-tabs>
    <button type="button" role="tab" data-period="today" aria-selected="false">今日</button>
    <button type="button" role="tab" data-period="week" aria-selected="false">今週</button>
    <button type="button" role="tab" data-period="season" aria-selected="true">${esc(season.name)}ぜんぶ</button>
  </div>
  <div class="filters" role="group" aria-label="原作の種類">
    <button type="button" class="chip" data-type-filter="all" aria-pressed="true">すべて</button>
    <button type="button" class="chip" data-type-filter="manga" aria-pressed="false">漫画</button>
    <button type="button" class="chip" data-type-filter="novel" aria-pressed="false">ラノベ</button>
  </div>
  <div class="tag-filter" role="group" aria-label="おすすめポイントで探す">
    <span class="tag-filter-label">おすすめポイントで探す</span>
    <div class="tag-filter-row">
      <button type="button" class="chip" data-tag-filter="" aria-pressed="true">指定なし</button>
${tags.map((t) => `      <button type="button" class="chip" data-tag-filter="${t.id}" aria-pressed="false">${esc(t.label)}</button>`).join('\n')}
    </div>
  </div>
  <div class="rank-search">
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
  <span class="event-kicker">${fmtDate(event.voteEnd)}まで</span>
  <span class="event-title">${esc(event.eventName)}</span>
  <span class="event-cta">投票する →</span>
</a>`
    : '';
  const body = `
<section class="hero">
  <p class="hero-kicker">${esc(site.tagline)}</p>
  <h1>${esc(currentSeason.label)}の原作、どれがすき？</h1>
  <p class="hero-lead">気になる作品の <span class="inline-heart">♡すき</span> をタップするだけ。1作品につき1日1回、いくつでも投票できます。</p>
</section>
${banner}
${rankingSection(currentSeason, { heading: `${currentSeason.label}原作 人気ランキング` })}
${shareBar('/', `${currentSeason.label}の原作、どれがすき？ 推しに「すき」を送ろう♡ #すきおし`, { label: 'このランキングをシェア' })}
${adSlot('top-bottom')}
<section class="section-links">
  <h2>シーズンを選ぶ</h2>
  <ul class="season-cards">
${ordered.map((s) => `    <li><a href="/season/${s.id}/"><span class="sc-name">${esc(s.label)}</span><span class="sc-meta">${esc(s.months)}・${s.works.length}作品</span></a></li>`).join('\n')}
  </ul>
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
  const m = s.works.filter((e) => workById.get(e.workId).type === 'manga').length;
  const n = s.works.length - m;
  const sequels = s.works.filter((e) => /期|Season|season|クール|STAGE/.test(e.note)).length;
  return `<p>${esc(s.label)}（${esc(s.months)}放送）のうち、漫画が原作の${m}作品と、ライトノベルが原作の${n}作品を集めました。${sequels ? `そのうち${sequels}作品は、続編や2クール目の放送です。` : ''}</p>
<p>アニメを見て原作が気になった作品や、原作から追いかけている作品に「すき」を送ってください。票は1作品につき1日1回まで入れられ、毎日の積み重ねで順位が決まります。</p>`;
}

function buildSeason(s) {
  const isEvent = Boolean(s.eventName);
  const h1 = isEvent ? s.eventName : `${s.label}の原作 人気ランキング`;
  const desc = isEvent
    ? `${s.label}（${s.months}放送）の原作漫画・ラノベ${s.works.length}作品から、いちばん「すき」な作品を選ぶ振り返り投票。${fmtDate(s.voteEnd)}まで投票できます。`
    : `${s.label}（${s.months}放送）の原作漫画・ラノベ${s.works.length}作品の人気ランキング。タップ1回で「すき」を投票でき、今日・今週・シーズン全体の順位が見られます。`;
  const body = `
<nav class="crumbs" aria-label="パンくずリスト"><a href="/">トップ</a><span aria-hidden="true">›</span><a href="/seasons/">シーズン</a><span aria-hidden="true">›</span><span>${esc(s.name)}</span></nav>
<article class="season-article">
  <h1>${esc(h1)}</h1>
  <div class="prose">
${seasonIntro(s)}
${s.article || ''}
  </div>
</article>
${rankingSection(s, { heading: isEvent ? '投票・ランキング' : `${s.label}原作ランキング` })}
${shareBar(`/season/${s.id}/`, `${isEvent ? s.eventName : `${s.label}の原作 人気ランキング`} 推しに「すき」を送ろう♡ #すきおし`, { label: 'このランキングをシェア' })}
${adSlot('season-bottom')}
<p class="back-link"><a href="/seasons/">ほかのシーズンを見る</a></p>`;
  const pageTitle = isEvent ? h1 : `${s.label}の原作 人気ランキング｜漫画・ラノベ${s.works.length}作品一覧`;
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'ItemList',
        name: `${s.label}の原作漫画・ライトノベル`,
        numberOfItems: s.works.length,
        itemListElement: s.works.map((e, i) => ({ '@type': 'ListItem', position: i + 1, name: workById.get(e.workId).title, url: `${SITE_URL}/works/${e.workId}/` })),
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'トップ', item: SITE_URL + '/' },
          { '@type': 'ListItem', position: 2, name: 'シーズン', item: `${SITE_URL}/seasons/` },
          { '@type': 'ListItem', position: 3, name: s.name, item: `${SITE_URL}/season/${s.id}/` },
        ],
      },
    ],
  };
  addPage(`/season/${s.id}/`, layout({ path: `/season/${s.id}/`, title: pageTitle, description: desc, body, jsonLd }), { priority: s.id === CURRENT ? 0.9 : 0.7 });
}

function buildSeasonList() {
  const body = `
<nav class="crumbs" aria-label="パンくずリスト"><a href="/">トップ</a><span aria-hidden="true">›</span><span>シーズン</span></nav>
<h1>シーズン一覧</h1>
<p>アニメの放送シーズンごとに、原作の人気ランキングを残しています。投票期間が終わったシーズンも、最終順位をいつでも見られます。</p>
<ul class="season-table">
${ordered
  .map(
    (s) => `  <li data-season-row data-vote-start="${s.voteStart}" data-vote-end="${s.voteEnd}">
    <a href="/season/${s.id}/"><span class="st-name">${esc(s.eventName || s.label + '原作ランキング')}</span>
    <span class="st-meta">${esc(s.months)}放送・${s.works.length}作品・投票 ${fmtDate(s.voteStart)}〜${fmtDate(s.voteEnd)}</span>
    <span class="st-status" data-season-status></span></a>
  </li>`
  )
  .join('\n')}
</ul>`;
  addPage('/seasons/', layout({ path: '/seasons/', title: 'シーズン一覧', description: 'すきおしのアニメ放送シーズン一覧。各シーズンの原作漫画・ラノベの人気ランキングと最終順位を見られます。', body }), { priority: 0.6 });
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
<p>すきおしにのっている、すべてのシーズンのアニメ原作（漫画・ラノベ）から作品名でさがせます。ひらがな・カタカナどちらでも大丈夫です。</p>
<div class="site-search" data-site-search>
  <input type="search" class="search-input search-input-large" data-site-search-input placeholder="作品名を入力（例：スライム、薬屋）" aria-label="作品名でさがす" autocomplete="off" enterkeyhint="search">
  <div class="filters" role="group" aria-label="原作の種類">
    <button type="button" class="chip" data-search-type="all" aria-pressed="true">すべて</button>
    <button type="button" class="chip" data-search-type="manga" aria-pressed="false">漫画</button>
    <button type="button" class="chip" data-search-type="novel" aria-pressed="false">ラノベ</button>
  </div>
  <p class="rank-status" data-site-search-status aria-live="polite"></p>
  <ul class="search-list">
${list}
  </ul>
</div>`;
  addPage('/search/', layout({ path: '/search/', title: 'アニメ・原作をさがす', description: 'すきおしにのっているアニメ原作の漫画・ライトノベルを作品名でさがせます。今のシーズンも過去のシーズンも検索できます。', body }), { priority: 0.5 });
}

// ---- 作品ページ ----
function buildWork(w) {
  const ss = seasonsOf(w.id).sort((a, b) => b.voteStart.localeCompare(a.voteStart));
  const main = ss[0];
  const note = noteOf(main, w.id);
  const typeLong = TYPE_LONG[w.type];
  const desc = w.intro
    ? clip(`『${w.title}』の原作${TYPE_SHORT[w.type]}はどんな話？ ${plain(w.intro)}`, 118)
    : `『${w.title}』は${main.label}にアニメが放送された${typeLong}原作の作品です。すきおしで今の順位を確認して、「すき」を投票できます。`;
  const related = main.works
    .filter((e) => e.workId !== w.id && workById.get(e.workId).type === w.type)
    .slice(0, 6)
    .map((e) => workById.get(e.workId));
  const share = `『${w.title}』がすき！ #すきおし`;
  const body = `
<nav class="crumbs" aria-label="パンくずリスト"><a href="/">トップ</a><span aria-hidden="true">›</span><a href="/season/${main.id}/">${esc(main.name)}</a><span aria-hidden="true">›</span><span>${esc(w.title)}</span></nav>
<article class="work" data-work-page="${w.id}">
  <div class="work-head">
    <a class="work-cover" data-book-link href="#" rel="sponsored noopener" target="_blank" aria-label="楽天ブックスで見る"><img data-cover="${w.id}" data-cover-size="large" alt="${esc(w.title)}の表紙" width="150" height="210"></a>
    <div class="work-info">
      <h1>${esc(w.title)}</h1>
      <p class="work-tags"><span class="tag tag-${w.type}">${typeLong}原作</span><span>${esc(main.label)}${note ? '・' + esc(note) : ''}</span></p>
      <p class="work-author" data-book-author hidden></p>
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
    <a class="btn btn-rakuten" data-book-link href="#" rel="sponsored noopener" target="_blank">楽天ブックスで原作を見る</a>
  </div>

  ${shareBar(`/works/${w.id}/`, share, { label: 'この作品をシェア' })}

  ${w.intro ? `<section class="prose work-intro"><h2>どんな作品？</h2>${w.intro}</section>` : ''}

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

  ${adSlot('work-bottom')}

  ${related.length ? `<section class="related">
    <h2>${esc(main.label)}のほかの${typeLong}原作</h2>
    <ul class="related-list">
${related.map((r) => `      <li><a href="/works/${r.id}/">${esc(r.title)}</a></li>`).join('\n')}
    </ul>
    <p><a href="/season/${main.id}/">${esc(main.label)}のランキングをすべて見る</a></p>
  </section>` : ''}
</article>`;
  addPage(`/works/${w.id}/`, layout({
    path: `/works/${w.id}/`,
    title: `${w.title}の原作${TYPE_SHORT[w.type]}｜${w.intro ? 'あらすじ・' : ''}人気順位`,
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

function buildStatic() {
  simplePage('/about/', 'このサイトについて', 'すきおしは、今期アニメの原作漫画・ラノベにタップで「すき」を投票できるランキングサイトです。運営者情報と投票の数え方を説明します。', `
<p>すきおしは、放送中のアニメの<strong>原作の漫画・ライトノベル</strong>に「すき」を送って、いまどの作品が好かれているかを見られるサイトです。アニメを見て原作が気になったときの作品選びや、推しの作品を応援する場所として使ってください。</p>
<h2>投票の数え方</h2>
<ul>
<li>「すき」は、1つの作品につき1台の端末から1日1回まで送れます。日付は日本時間の0時に切り替わります。</li>
<li>いくつの作品に投票してもかまいません。</li>
<li>ランキングは「今日」「今週（直近7日間）」「シーズン全体」の3つの期間で見られます。</li>
<li>短い時間に大量の票が集中した場合など、不自然な票は数えないことがあります。</li>
<li>シーズンの投票期間が終わると投票は締め切り、そのときの順位が最終順位になります。</li>
</ul>
<h2>対象になる作品</h2>
<p>そのシーズンに放送されるテレビアニメ・配信アニメのうち、原作が漫画またはライトノベルの作品を対象にしています。映画、オリジナルアニメ、ゲームが原作の作品は対象外です。</p>
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
<p>原作が漫画またはライトノベルのアニメを対象にしています。対象のはずの作品が見つからないときは、作品名を添えてご連絡ください。</p>
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
for (const s of seasons) buildSeason(s);
for (const w of works) if (seasonsOf(w.id).length) buildWork(w);
buildStatic();

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
