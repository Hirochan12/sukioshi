// サーバー側（Pages Functions）で共通に使う処理
import seasonsData from '../../data/seasons.json';
import works from '../../data/works.json';
import tags from '../../data/tags.json';

export const SEASONS = seasonsData.seasons;
export const CURRENT_SEASON = seasonsData.current;
export const WORKS = new Map(works.map((w) => [w.id, w]));
export const TAGS = new Map(tags.map((t) => [t.id, t]));
export const MAX_TAGS = 3;

export function getSeason(id) {
  return SEASONS.find((s) => s.id === id) || null;
}

export function seasonHasWork(season, workId) {
  return season.works.some((w) => w.workId === workId);
}

// 日本時間の「今日」を YYYY-MM-DD で返す
export function jstDay(date = new Date(Date.now())) {
  return new Date(date.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

// YYYY-MM-DD に日数を足す
export function addDays(day, n) {
  const d = new Date(day + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// その日を含む週の月曜日（日本時間の日付として）
export function mondayOf(day) {
  const d = new Date(day + 'T00:00:00Z');
  const dow = (d.getUTCDay() + 6) % 7; // 月=0 … 日=6
  return addDays(day, -dow);
}

export function isVotingOpen(season, day = jstDay()) {
  return day >= season.voteStart && day <= season.voteEnd;
}

export function json(data, init = {}) {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  if (!headers.has('cache-control')) headers.set('cache-control', 'no-store');
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function errorJson(status, code, message) {
  return json({ ok: false, code, message }, { status });
}

export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function readCookie(request, name) {
  const cookie = request.headers.get('cookie') || '';
  for (const part of cookie.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

// 期間ごとの集計範囲（日付の範囲）
export function periodRange(season, period, today = jstDay()) {
  const end = today < season.voteEnd ? today : season.voteEnd;
  if (period === 'today') return { from: end, to: end };
  if (period === 'week') return { from: addDays(end, -6), to: end };
  return { from: season.voteStart, to: season.voteEnd }; // season = 今期ぜんぶ
}

// 指定範囲の作品ごとの票数を数え、順位付きで返す（0票の作品も含む）
// tag を指定すると「そのタグを選んだ人数」で数える
export async function countVotes(db, season, from, to, type = 'all', tag = null) {
  const stmt = tag
    ? db
        .prepare('SELECT work_id, COUNT(*) AS n FROM tag_votes WHERE season = ?1 AND day >= ?2 AND day <= ?3 AND tag = ?4 GROUP BY work_id')
        .bind(season.id, from, to, tag)
    : db
        .prepare('SELECT work_id, COUNT(*) AS n FROM votes WHERE season = ?1 AND day >= ?2 AND day <= ?3 GROUP BY work_id')
        .bind(season.id, from, to);
  const { results } = await stmt.all();
  const counts = new Map(results.map((r) => [r.work_id, r.n]));
  const rows = season.works
    .map((w) => ({ workId: w.workId, count: counts.get(w.workId) || 0 }))
    .filter((r) => type === 'all' || WORKS.get(r.workId)?.type === type);
  rows.sort((a, b) => b.count - a.count || a.workId.localeCompare(b.workId));
  // 同じ票数は同じ順位
  let rank = 0;
  let prev = -1;
  rows.forEach((r, i) => {
    if (r.count !== prev) rank = i + 1;
    r.rank = r.count > 0 ? rank : null;
    prev = r.count;
  });
  return rows;
}
