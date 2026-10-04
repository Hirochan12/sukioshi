// GET /api/book?id=w001
// 楽天ブックス書籍検索APIから、作品の表紙画像と楽天の商品リンクを取ってくる。
// APIキーはサーバー側（Cloudflareの環境変数）だけに置き、ブラウザには出さない。
import { WORKS, json, errorJson } from '../_lib/common.js';

const ENDPOINT = 'https://openapi.rakuten.co.jp/services/api/BooksBook/Search/20170404';
const GENRE = { manga: '001001', novel: '001017' }; // 楽天ブックス: コミック / ライトノベル
const CACHE_SECONDS = 60 * 60 * 24; // 1日

export async function onRequestGet({ request, env, waitUntil }) {
  const id = new URL(request.url).searchParams.get('id') || '';
  const work = WORKS.get(id);
  if (!work) return errorJson(404, 'unknown_work', '作品が見つかりません。');

  const cacheKey = new Request(`https://cache.sukioshi/book/v2/${id}`);
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  if (!env.RAKUTEN_APP_ID || !env.RAKUTEN_ACCESS_KEY) {
    return json({ ok: false, code: 'not_configured' });
  }

  // 見つからないときは、条件をゆるめて最大3回さがす
  //  1) 検索語＋ジャンル（漫画/ラノベ）  2) 検索語のみ（単行本の小説なども対象）  3) 検索語を短くして
  const query = work.rakutenQuery || work.title;
  const short = query.split(/[ 　、,，【】「」『』（）()~～\-―]/).filter(Boolean)[0].slice(0, 14);
  const attempts = [
    { title: query, booksGenreId: GENRE[work.type] || '001' },
    { title: query, booksGenreId: '001' },
  ];
  if (short && short !== query) attempts.push({ title: short, booksGenreId: GENRE[work.type] || '001' });

  // 楽天に登録した自分のサイトのURLを名乗る（楽天の「許可されたWebサイト」と一致させる）
  const site = env.SITE_URL || new URL(request.url).origin;
  let data = null;
  for (let i = 0; i < attempts.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 1100)); // 楽天APIは1秒に1回まで
    const params = new URLSearchParams({
      applicationId: env.RAKUTEN_APP_ID,
      accessKey: env.RAKUTEN_ACCESS_KEY,
      ...attempts[i],
      sort: '+releaseDate', // 古い順 → 1巻が先に来やすい
      hits: '10',
      outOfStockFlag: '1',
      formatVersion: '2',
    });
    if (work.rakutenAuthor) params.set('author', work.rakutenAuthor);
    if (env.RAKUTEN_AFFILIATE_ID) params.set('affiliateId', env.RAKUTEN_AFFILIATE_ID);
    try {
      const res = await fetch(`${ENDPOINT}?${params}`, { headers: { Origin: site, Referer: site + '/' } });
      if (!res.ok) {
        // 404 は「0件」の意味。それ以外（429など）は混雑なので、あとでもう一度
        if (res.status === 404) continue;
        return json({ ok: false, code: res.status === 429 ? 'busy' : 'api_error', status: res.status });
      }
      const body = await res.json();
      if ((body.Items || []).length) { data = body; break; }
    } catch {
      return json({ ok: false, code: 'api_error' });
    }
  }
  data = data || { Items: [] };

  const items = (data.Items || []).map((x) => x.Item || x);
  const item = items.find((x) => x.largeImageUrl && !/noimage/.test(x.largeImageUrl)) || items[0];
  const out = item
    ? {
        ok: true,
        title: item.title,
        author: item.author || '',
        publisherName: item.publisherName || '',
        seriesName: item.seriesName || '',
        // 200px の画像を少し大きめ（_ex=300x300）で取得
        imageUrl: item.largeImageUrl ? item.largeImageUrl.replace(/_ex=\d+x\d+/, '_ex=300x300') : '',
        url: item.affiliateUrl || item.itemUrl,
      }
    : { ok: false, code: 'not_found' };

  // 見つからなかった結果は短めに保存（作品データを直したらすぐ反映されるように）
  const maxAge = out.ok ? CACHE_SECONDS : 60 * 30;
  const response = json(out, { headers: { 'cache-control': `public, max-age=${maxAge}` } });
  waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}
