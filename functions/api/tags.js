// 「ここがおすすめ」タグ
//   GET  /api/tags?season=2026-autumn&workId=w075   … その作品のタグ集計
//   POST /api/tags  { season, workId, tags: ["sakuga", ...] } … 今日「すき」を送った作品にだけ、1日3つまで
import {
  TAGS, MAX_TAGS, getSeason, seasonHasWork, isVotingOpen, jstDay, json, errorJson, readCookie,
} from '../_lib/common.js';

async function tagCounts(db, season, workId) {
  const { results } = await db
    .prepare('SELECT tag, COUNT(*) AS n FROM tag_votes WHERE season = ?1 AND work_id = ?2 GROUP BY tag ORDER BY n DESC')
    .bind(season.id, workId)
    .all();
  return results.filter((r) => TAGS.has(r.tag)).map((r) => ({ tag: r.tag, label: TAGS.get(r.tag).label, count: r.n }));
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const season = getSeason(url.searchParams.get('season') || '');
  const workId = url.searchParams.get('workId') || '';
  if (!season || !seasonHasWork(season, workId)) return errorJson(404, 'unknown_work', '作品が見つかりません。');
  return json({ ok: true, tags: await tagCounts(env.DB, season, workId) });
}

export async function onRequestPost({ request, env }) {
  const origin = request.headers.get('origin');
  if (origin && new URL(origin).host !== new URL(request.url).host) {
    return errorJson(403, 'bad_origin', '送れませんでした。');
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return errorJson(400, 'bad_request', '送れませんでした。');
  }
  const season = getSeason(String(body?.season || ''));
  const workId = String(body?.workId || '');
  if (!season || !seasonHasWork(season, workId)) return errorJson(400, 'unknown_work', 'この作品には送れません。');
  const day = jstDay();
  if (!isVotingOpen(season, day)) return errorJson(403, 'closed', `${season.name}の投票は終了しました。`);

  const picked = [...new Set(Array.isArray(body?.tags) ? body.tags.map(String) : [])].filter((t) => TAGS.has(t));
  if (!picked.length) return errorJson(400, 'no_tags', 'タグを選んでください。');
  if (picked.length > MAX_TAGS) return errorJson(400, 'too_many', `タグは${MAX_TAGS}つまで選べます。`);

  const voter = readCookie(request, 'sk_vid');
  if (!voter) return errorJson(403, 'vote_first', '先に「すき」を送ってください。');
  const db = env.DB;
  const [voted, already] = await db.batch([
    db.prepare('SELECT 1 AS ok FROM votes WHERE season = ?1 AND work_id = ?2 AND day = ?3 AND voter = ?4').bind(season.id, workId, day, voter),
    db.prepare('SELECT tag FROM tag_votes WHERE season = ?1 AND work_id = ?2 AND day = ?3 AND voter = ?4').bind(season.id, workId, day, voter),
  ]);
  if (!voted.results.length) return errorJson(403, 'vote_first', '先に「すき」を送ってください。');

  const have = new Set(already.results.map((r) => r.tag));
  const fresh = picked.filter((t) => !have.has(t)).slice(0, Math.max(0, MAX_TAGS - have.size));
  if (fresh.length) {
    const now = Date.now();
    await db.batch(
      fresh.map((t) =>
        db.prepare('INSERT OR IGNORE INTO tag_votes (season, work_id, day, voter, tag, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
          .bind(season.id, workId, day, voter, t, now)
      )
    );
    // タグ別ランキングの使い回しを消す
    const cache = caches.default;
    await Promise.all(
      fresh.flatMap((t) =>
        ['today', 'week', 'season'].flatMap((p) =>
          ['all', 'manga', 'novel'].map((ty) => cache.delete(new Request(`https://cache.sukioshi/ranking/${season.id}/${p}/${ty}/${t}`)))
        )
      )
    );
  }
  return json({ ok: true, added: fresh.length, tags: await tagCounts(db, season, workId) });
}
