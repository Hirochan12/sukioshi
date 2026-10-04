// GET /api/admin/weekly?season=2026-autumn   （ヘッダー X-Admin-Key が必要）
// 運営者用：先週（月〜日）の集計と、X投稿文の候補を返す。
import {
  getSeason, CURRENT_SEASON, WORKS, jstDay, addDays, mondayOf, countVotes, json, errorJson,
} from '../../_lib/common.js';
import { buildWeeklyPosts } from '../../_lib/weekly-post.js';

export async function onRequestGet({ request, env }) {
  const key = request.headers.get('x-admin-key') || '';
  if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) {
    return errorJson(401, 'unauthorized', '合言葉が違います。');
  }
  const url = new URL(request.url);
  const season = getSeason(url.searchParams.get('season') || CURRENT_SEASON);
  if (!season) return errorJson(404, 'unknown_season', 'シーズンが見つかりません。');

  const today = jstDay();
  // 先週の月曜〜日曜。まだ1週間たっていなければ「今週これまで」
  let from = addDays(mondayOf(today), -7);
  let to = addDays(from, 6);
  let label = '先週';
  if (to < season.voteStart) {
    from = season.voteStart;
    to = today;
    label = '今週これまで';
  }
  let now = await countVotes(env.DB, season, from, to);
  // 先週に票がなければ（始めたばかりなど）、今週これまでの集計にする
  if (label === '先週' && !now.some((r) => r.count > 0)) {
    from = mondayOf(today);
    to = today;
    label = '今週これまで';
    now = await countVotes(env.DB, season, from, to);
  }
  const prevFrom = addDays(from, -7);
  const prevTo = addDays(from, -1);
  const prev = await countVotes(env.DB, season, prevFrom, prevTo);
  const prevRank = new Map(prev.map((r) => [r.workId, r.rank]));
  const withTitle = (r) => ({ ...r, title: WORKS.get(r.workId)?.title || r.workId, prevRank: prevRank.get(r.workId) ?? null });

  const top = now.filter((r) => r.count > 0).slice(0, 5).map(withTitle);
  // 急上昇：上位5作品以外で、先週より順位を一番上げた作品（先週0票→今週ランクインも含む）
  const topIds = new Set(top.map((r) => r.workId));
  const riser = now
    .filter((r) => r.count > 0 && !topIds.has(r.workId))
    .map(withTitle)
    .map((r) => ({ ...r, gain: (r.prevRank ?? season.works.length + 1) - r.rank }))
    .filter((r) => r.gain > 0)
    .sort((a, b) => b.gain - a.gain || b.count - a.count)[0] || null;

  const site = env.SITE_URL || url.origin;
  const weekNo = Math.floor(new Date(from + 'T00:00:00Z').getTime() / (7 * 86400000));
  const posts = top.length
    ? buildWeeklyPosts({ seasonName: season.name, top, riser, url: `${site}/season/${season.id}/`, seed: weekNo })
    : [];

  return json({ ok: true, season: season.id, label, from, to, top, riser, posts });
}
