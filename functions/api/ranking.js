// GET /api/ranking?season=2026-autumn&period=today|week|season&type=all|manga|novel
import { getSeason, CURRENT_SEASON, periodRange, countVotes, isVotingOpen, json, errorJson } from '../_lib/common.js';

export async function onRequestGet({ request, env, waitUntil }) {
  const url = new URL(request.url);
  const season = getSeason(url.searchParams.get('season') || CURRENT_SEASON);
  if (!season) return errorJson(404, 'unknown_season', 'シーズンが見つかりません。');
  const period = ['today', 'week', 'season'].includes(url.searchParams.get('period'))
    ? url.searchParams.get('period')
    : 'season';
  const type = ['manga', 'novel'].includes(url.searchParams.get('type')) ? url.searchParams.get('type') : 'all';

  // 同じ集計を1分間は使い回す（データベースへの負担を減らす）
  const cacheKey = new Request(`https://cache.sukioshi/ranking/${season.id}/${period}/${type}`);
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const { from, to } = periodRange(season, period);
  const rows = await countVotes(env.DB, season, from, to, type);
  const res = json(
    { ok: true, season: season.id, period, type, from, to, open: isVotingOpen(season), rows },
    { headers: { 'cache-control': 'public, max-age=0, s-maxage=60' } } // ブラウザには保存させず、Cloudflare側だけで1分使い回す
  );
  waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}
