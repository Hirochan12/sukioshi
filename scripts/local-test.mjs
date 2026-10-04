// 手元での動作確認用。Cloudflare なしで、サーバー処理（functions/）とページ（dist/）を動かす。
//   node --experimental-sqlite scripts/local-test.mjs          … 自動テストを実行
//   node --experimental-sqlite scripts/local-test.mjs --serve  … http://localhost:8788 で開いたままにする
import { register } from 'node:module';
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';

// functions/ の中の「import x from '...json'」を Node でも読めるようにする
register(
  'data:text/javascript,' +
    encodeURIComponent(`
export async function load(url, ctx, next) {
  if (url.endsWith('.json')) {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    return { format: 'module', shortCircuit: true, source: 'export default ' + readFileSync(fileURLToPath(url), 'utf8') };
  }
  return next(url, ctx);
}`)
);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const PORT = 8788;

// ---- D1 のかわり（SQLite） ----
function makeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(join(ROOT, 'schema.sql'), 'utf8'));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    async all() { return { results: db.prepare(sql).all(...args) }; },
    async first() { return db.prepare(sql).get(...args) ?? null; },
    async run() { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
  });
  return {
    raw: db,
    prepare: (sql) => stmt(sql),
    async batch(list) { return Promise.all(list.map((s) => s.all())); },
  };
}

// ---- Cache API のかわり ----
const cacheStore = new Map();
globalThis.caches = {
  default: {
    async match(req) { const r = cacheStore.get(req.url); return r ? r.clone() : undefined; },
    async put(req, res) { cacheStore.set(req.url, res); },
    async delete(req) { return cacheStore.delete(req.url); },
  },
};
const clearCache = () => cacheStore.clear();

// ---- 楽天APIのかわり（テスト用の偽データ） ----
const realFetch = globalThis.fetch;
let rakutenCalls = 0;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.startsWith('https://openapi.rakuten.co.jp/')) {
    rakutenCalls++;
    const u = new URL(url);
    const title = u.searchParams.get('title');
    return new Response(JSON.stringify({
      Items: [{ title: title + '（1）', author: 'テスト作者', publisherName: 'テスト出版', largeImageUrl: '/assets/og.png?_ex=200x200', affiliateUrl: 'https://hb.afl.rakuten.co.jp/test', itemUrl: 'https://books.rakuten.co.jp/test' }],
    }), { headers: { 'content-type': 'application/json' } });
  }
  return realFetch(input, init);
};

// ---- ルーティング ----
const routes = {
  '/api/vote': await import(pathToFileURL(join(ROOT, 'functions/api/vote.js'))),
  '/api/ranking': await import(pathToFileURL(join(ROOT, 'functions/api/ranking.js'))),
  '/api/book': await import(pathToFileURL(join(ROOT, 'functions/api/book.js'))),
  '/api/tags': await import(pathToFileURL(join(ROOT, 'functions/api/tags.js'))),
  '/api/admin/weekly': await import(pathToFileURL(join(ROOT, 'functions/api/admin/weekly.js'))),
};
const env = {
  DB: makeD1(),
  ADMIN_KEY: 'test-admin',
  HASH_SALT: 'salt',
  RAKUTEN_APP_ID: 'x',
  RAKUTEN_ACCESS_KEY: 'y',
  SITE_URL: `http://localhost:${PORT}`,
};

async function handle(request) {
  const url = new URL(request.url);
  const mod = routes[url.pathname];
  if (mod) {
    const method = request.method.toUpperCase();
    const fn = mod[`onRequest${method[0] + method.slice(1).toLowerCase()}`] || mod.onRequest;
    if (!fn) return new Response('Method Not Allowed', { status: 405 });
    const waits = [];
    const res = await fn({ request, env, waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
    return res;
  }
  // 静的ファイル
  let p = join(DIST, decodeURIComponent(url.pathname));
  if (existsSync(p) && statSync(p).isDirectory()) p = join(p, 'index.html');
  if (!existsSync(p)) return new Response(readFileSync(join(DIST, '404.html')), { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } });
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.xml': 'application/xml', '.txt': 'text/plain' };
  return new Response(readFileSync(p), { headers: { 'content-type': types[extname(p)] || 'application/octet-stream' } });
}

// ---- 自動テスト ----
const call = (path, init = {}, ip = '1.1.1.1') => {
  const headers = new Headers(init.headers);
  headers.set('cf-connecting-ip', ip);
  return handle(new Request(`http://localhost:${PORT}${path}`, { ...init, headers }));
};
const vote = (season, workId, cookie, ip) =>
  call('/api/vote', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: `http://localhost:${PORT}`, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ season, workId }),
  }, ip);

async function runTests() {
  const seasons = JSON.parse(readFileSync(join(ROOT, 'data/seasons.json'), 'utf8'));
  const autumn = seasons.seasons.find((s) => s.id === '2026-autumn');
  const w1 = autumn.works[0].workId;
  const w2 = autumn.works[1].workId;
  let n = 0;
  const ok = (name) => console.log(`  ok ${++n} - ${name}`);

  // 0票のランキング
  let r = await (await call('/api/ranking?season=2026-autumn')).json();
  assert.equal(r.ok, true);
  assert.equal(r.rows.length, autumn.works.length);
  assert.ok(r.rows.every((x) => x.count === 0 && x.rank === null));
  ok('0票でもランキングが返る（全作品、順位なし）');

  // 1票目：Cookieが発行される
  let res = await vote('2026-autumn', w1);
  let body = await res.json();
  assert.equal(body.status, 'counted');
  assert.equal(body.rank, 1);
  const setCookie = res.headers.get('set-cookie');
  assert.match(setCookie, /sk_vid=[a-f0-9-]{36}/);
  const cookie = setCookie.split(';')[0];
  ok('投票すると数えられ、端末IDのCookieが発行される');

  // 同じ端末・同じ作品・同じ日 → 数えない
  body = await (await vote('2026-autumn', w1, cookie)).json();
  assert.equal(body.status, 'already');
  assert.equal(body.count, 1);
  ok('同じ作品に同じ日2回目は数えない');

  // 別の作品なら数える
  body = await (await vote('2026-autumn', w2, cookie)).json();
  assert.equal(body.status, 'counted');
  ok('別の作品には投票できる');

  // 別の端末から w2 にもう1票 → w2 が1位
  body = await (await vote('2026-autumn', w2, null, '2.2.2.2')).json();
  assert.equal(body.rank, 1);
  assert.equal(body.count, 2);
  clearCache();
  r = await (await call('/api/ranking?season=2026-autumn&period=today')).json();
  assert.equal(r.rows[0].workId, w2);
  assert.equal(r.rows[0].rank, 1);
  assert.equal(r.rows[1].workId, w1);
  assert.equal(r.rows[1].rank, 2);
  assert.equal(r.rows[2].rank, null);
  ok('票の多い順に並び、順位が正しい');

  // 同じ票数は同じ順位
  await vote('2026-autumn', w1, null, '3.3.3.3');
  clearCache();
  r = await (await call('/api/ranking?season=2026-autumn&period=week')).json();
  assert.equal(r.rows[0].rank, 1);
  assert.equal(r.rows[1].rank, 1);
  ok('同じ票数は同じ順位になる');

  // 種類で絞り込み
  clearCache();
  r = await (await call('/api/ranking?season=2026-autumn&type=novel')).json();
  const worksData = JSON.parse(readFileSync(join(ROOT, 'data/works.json'), 'utf8'));
  const typeOf = new Map(worksData.map((w) => [w.id, w.type]));
  assert.ok(r.rows.length > 0 && r.rows.every((x) => typeOf.get(x.workId) === 'novel'));
  ok('ラノベだけに絞り込める');

  // おかしな入力
  assert.equal((await vote('2026-autumn', 'w999')).status, 400);
  assert.equal((await vote('2099-winter', w1)).status, 400);
  assert.equal((await vote('2026-autumn', autumn.works[0].workId.replace('w', 'x'))).status, 400);
  let bad = await call('/api/vote', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{壊れたJSON' });
  assert.equal(bad.status, 400);
  bad = await call('/api/vote', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: JSON.stringify({ season: '2026-autumn', workId: w1 }) });
  assert.equal(bad.status, 403);
  assert.equal((await call('/api/vote')).status, 405);
  r = await (await call('/api/ranking?season=2026-autumn&period=zzz&type=<script>')).json();
  assert.equal(r.period, 'season');
  assert.equal(r.type, 'all');
  assert.equal((await call('/api/ranking?season=nope')).status, 404);
  ok('存在しない作品・シーズン、壊れたデータ、他サイトからの投票を断る');

  // 他のシーズンの作品はそのシーズンでは投票できない
  const summerWork = seasons.seasons.find((s) => s.id === '2026-summer').works[0].workId;
  assert.equal((await vote('2026-autumn', summerWork)).status, 400);
  ok('別シーズンの作品には投票できない');

  // 連打（1分間に20票まで）
  let limited = 0;
  const spamCookie = 'sk_vid=11111111-1111-4111-8111-111111111111';
  for (const e of autumn.works.slice(0, 25)) {
    const b = await (await vote('2026-autumn', e.workId, spamCookie, '9.9.9.9')).json();
    if (b.status === 'limited') limited++;
  }
  assert.equal(limited, 5);
  ok('1分間に20票を超える連打は数えない');

  // 同じ回線から1作品15票まで
  let counted = 0;
  for (let i = 0; i < 18; i++) {
    const b = await (await vote('2026-autumn', autumn.works[5].workId, `sk_vid=00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, '8.8.8.8')).json();
    if (b.status === 'counted') counted++;
  }
  assert.equal(counted, 15);
  ok('同じ回線から1作品へは1日15票まで');

  // IPアドレスがそのまま保存されていない
  const rows = env.DB.raw.prepare('SELECT ip_hash FROM votes').all();
  assert.ok(rows.every((x) => !x.ip_hash.includes('.') && x.ip_hash.length === 32));
  ok('IPアドレスはそのまま保存せずハッシュ化している');

  // 締め切ったシーズンには投票できない
  const { onRequestPost } = routes['/api/vote'];
  const realNow = Date.now;
  Date.now = () => new Date('2027-01-05T12:00:00+09:00').getTime();
  const closed = await onRequestPost({ request: new Request(`http://localhost:${PORT}/api/vote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ season: '2026-autumn', workId: w1 }) }), env });
  Date.now = realNow;
  assert.equal(closed.status, 403);
  assert.match((await closed.json()).message, /終了/);
  ok('投票期間が終わったシーズンには投票できない');

  // 「ここがおすすめ」タグ
  const postTags = (workId, tags, ck) =>
    call('/api/tags', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: `http://localhost:${PORT}`, ...(ck ? { cookie: ck } : {}) },
      body: JSON.stringify({ season: '2026-autumn', workId, tags }),
    }, '5.5.5.5');
  const tagCookie = 'sk_vid=22222222-2222-4222-8222-222222222222';
  assert.equal((await postTags(w1, ['sakuga'], tagCookie)).status, 403); // まだ「すき」を送っていない
  await vote('2026-autumn', w1, tagCookie, '5.5.5.5');
  assert.equal((await postTags(w1, ['sakuga', 'naku', 'warau', 'kawaii'], tagCookie)).status, 400); // 4つは多すぎ
  assert.equal((await postTags(w1, ['<script>'], tagCookie)).status, 400); // 存在しないタグ
  let tg = await (await postTags(w1, ['sakuga', 'naku'], tagCookie)).json();
  assert.equal(tg.added, 2);
  tg = await (await postTags(w1, ['naku', 'warau', 'kawaii'], tagCookie)).json();
  assert.equal(tg.added, 1); // 1日3つまで（naku は重複、kawaii は上限超え）
  assert.equal(tg.tags.reduce((a, t) => a + t.count, 0), 3);
  const otherCookie = 'sk_vid=33333333-3333-4333-8333-333333333333';
  await vote('2026-autumn', w2, otherCookie, '6.6.6.6');
  await call('/api/tags', { method: 'POST', headers: { 'content-type': 'application/json', origin: `http://localhost:${PORT}`, cookie: otherCookie }, body: JSON.stringify({ season: '2026-autumn', workId: w2, tags: ['naku'] }) }, '6.6.6.6');
  await vote('2026-autumn', w2, tagCookie, '5.5.5.5');
  await postTags(w2, ['naku'], tagCookie);
  clearCache();
  r = await (await call('/api/ranking?season=2026-autumn&tag=naku')).json();
  assert.equal(r.tag, 'naku');
  assert.equal(r.rows[0].workId, w2);
  assert.equal(r.rows[0].count, 2);
  assert.equal(r.rows[1].workId, w1);
  const g = await (await call(`/api/tags?season=2026-autumn&workId=${w1}`)).json();
  assert.equal(g.tags[0].count, 1);
  assert.ok(g.tags.every((t) => t.label));
  ok('おすすめタグ：すきの後だけ・1日3つまで・存在しないタグは断る・タグ別ランキング');

  // 楽天の表紙
  let book = await (await call(`/api/book?id=${w1}`)).json();
  assert.equal(book.ok, true);
  assert.match(book.imageUrl, /_ex=300x300/);
  assert.equal(book.url, 'https://hb.afl.rakuten.co.jp/test');
  const before = rakutenCalls;
  await call(`/api/book?id=${w1}`);
  assert.equal(rakutenCalls, before);
  assert.equal((await call('/api/book?id=nope')).status, 404);
  const envNoKey = { ...env, RAKUTEN_APP_ID: '' };
  clearCache();
  const nk = await routes['/api/book'].onRequestGet({ request: new Request(`http://localhost/api/book?id=${w2}`), env: envNoKey, waitUntil() {} });
  assert.equal((await nk.json()).code, 'not_configured');
  ok('楽天の表紙・アフィリエイトリンクを取得し、2回目はキャッシュを使う');

  // 運営者ページ
  assert.equal((await call('/api/admin/weekly')).status, 401);
  assert.equal((await call('/api/admin/weekly', { headers: { 'x-admin-key': 'wrong' } })).status, 401);
  const wk = await (await call('/api/admin/weekly?season=2026-autumn', { headers: { 'x-admin-key': 'test-admin' } })).json();
  assert.equal(wk.ok, true);
  assert.ok(wk.posts.length === 3, 'X投稿文が3案ある');
  const { xLength } = await import(pathToFileURL(join(ROOT, 'functions/_lib/weekly-post.js')));
  assert.ok(wk.posts.every((t) => xLength(t) <= 280));
  assert.equal(new Set(wk.posts).size, 3);
  ok('週間投稿文：合言葉が必要、3案とも280文字以内で文面が違う');

  // 長いタイトルでも280文字に収まる
  const { buildWeeklyPosts } = await import(pathToFileURL(join(ROOT, 'functions/_lib/weekly-post.js')));
  const long = 'とても長いタイトルの作品名がここに入りますとても長いタイトルの作品名がここに入ります';
  const posts = buildWeeklyPosts({ seasonName: '2026秋', top: Array(5).fill({ title: long }), riser: { title: long }, url: 'https://sukioshi.pages.dev/season/2026-autumn/', seed: 3 });
  assert.ok(posts.length === 3 && posts.every((t) => xLength(t) <= 280));
  ok('とても長いタイトルでも投稿文が280文字に収まる');

  // ページ
  const html = await (await call('/')).text();
  assert.match(html, /<title>[^<]+<\/title>/);
  assert.match(html, /<meta name="description" content="[^"]+">/);
  assert.equal((html.match(/<h1[ >]/g) || []).length, 1);
  assert.match(html, /<link rel="canonical"/);
  assert.equal((await call('/works/w001/')).status, 200);
  assert.equal((await call('/season/2026-summer/')).status, 200);
  assert.equal((await call('/nope/')).status, 404);
  const adminHtml = await (await call('/admin/weekly/')).text();
  assert.match(adminHtml, /noindex/);
  ok('主要ページが開け、title・description・h1・canonical がある');

  // 全ページの内部リンクが切れていない
  const { readdirSync } = await import('node:fs');
  const htmlFiles = [];
  const walk = (d) => readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.html') && htmlFiles.push(join(d, e.name))));
  walk(DIST);
  const broken = new Set();
  const titles = new Map();
  for (const f of htmlFiles) {
    const src = readFileSync(f, 'utf8');
    for (const [, href] of src.matchAll(/href="(\/[^"#?]*)/g)) {
      let p = join(DIST, href);
      if (existsSync(p) && statSync(p).isDirectory()) p = join(p, 'index.html');
      if (!existsSync(p)) broken.add(`${f.replace(DIST, '')} → ${href}`);
    }
    const t = src.match(/<title>([^<]+)<\/title>/)?.[1];
    if (!f.endsWith('404.html')) {
      assert.equal((src.match(/<h1[ >]/g) || []).length, 1, `h1は1つ: ${f}`);
      if (titles.has(t)) throw new Error(`titleが重複: ${t}`);
      titles.set(t, f);
    }
  }
  assert.deepEqual([...broken], []);
  ok(`全${htmlFiles.length}ページでリンク切れなし・titleの重複なし・h1は1つ`);

  console.log(`\nすべて成功（${n}件）`);
}

if (process.argv.includes('--serve')) {
  createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
    if (!headers.has('cf-connecting-ip')) headers.set('cf-connecting-ip', req.socket.remoteAddress || '127.0.0.1');
    const request = new Request(`http://localhost:${PORT}${req.url}`, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
    });
    const r = await handle(request);
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
  }).listen(PORT, () => console.log(`http://localhost:${PORT} で動いています（Ctrl+C で終了）`));
} else {
  await runTests();
}
