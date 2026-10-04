// POST /api/vote  { season, workId }
// 「すき」を1票記録する。1作品につき1端末1日1回まで。
import {
  getSeason, seasonHasWork, isVotingOpen, jstDay, json, errorJson,
  sha256Hex, readCookie, countVotes,
} from '../_lib/common.js';

const COOKIE = 'sk_vid';
const LIMIT_VOTER_PER_MINUTE = 20; // 1端末が1分間に入れられる票の上限
const LIMIT_IP_PER_WORK_DAY = 15;   // 同じ回線から1作品へ1日に入る票の上限（学校・家族の共有回線を考えて少し多め）
const LIMIT_IP_PER_DAY = 300;       // 同じ回線から1日に入る票の上限

export async function onRequestPost({ request, env }) {
  // ほかのサイトから勝手に投票させない
  const origin = request.headers.get('origin');
  if (origin && new URL(origin).host !== new URL(request.url).host) {
    return errorJson(403, 'bad_origin', '投票できませんでした。');
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return errorJson(400, 'bad_request', '投票できませんでした。');
  }
  const season = getSeason(String(body?.season || ''));
  const workId = String(body?.workId || '');
  if (!season || !seasonHasWork(season, workId)) {
    return errorJson(400, 'unknown_work', 'この作品には投票できません。');
  }
  const day = jstDay();
  if (!isVotingOpen(season, day)) {
    return errorJson(403, 'closed', `${season.name}の投票は終了しました。`);
  }

  // 端末ID（なければ新しく発行）
  let voter = readCookie(request, COOKIE);
  const isNewVoter = !voter || !/^[a-f0-9-]{36}$/.test(voter);
  if (isNewVoter) voter = crypto.randomUUID();

  // IPアドレスはそのまま保存せず、日替わりの鍵でハッシュ化する
  const ip = request.headers.get('cf-connecting-ip') || '0.0.0.0';
  const ipHash = (await sha256Hex(`${env.HASH_SALT || 'sukioshi'}:${day}:${ip}`)).slice(0, 32);
  const now = Date.now();

  const db = env.DB;
  const [byVoter, byIpWork, byIpDay] = await db.batch([
    db.prepare('SELECT COUNT(*) AS n FROM votes WHERE voter = ?1 AND created_at > ?2').bind(voter, now - 60_000),
    db.prepare('SELECT COUNT(*) AS n FROM votes WHERE ip_hash = ?1 AND work_id = ?2 AND day = ?3').bind(ipHash, workId, day),
    db.prepare('SELECT COUNT(*) AS n FROM votes WHERE ip_hash = ?1 AND day = ?2').bind(ipHash, day),
  ]);
  const tooMany =
    byVoter.results[0].n >= LIMIT_VOTER_PER_MINUTE ||
    byIpWork.results[0].n >= LIMIT_IP_PER_WORK_DAY ||
    byIpDay.results[0].n >= LIMIT_IP_PER_DAY;

  let status = 'counted';
  if (tooMany) {
    status = 'limited';
  } else {
    const res = await db
      .prepare('INSERT OR IGNORE INTO votes (season, work_id, day, voter, ip_hash, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
      .bind(season.id, workId, day, voter, ipHash, now)
      .run();
    if (res.meta.changes === 0) status = 'already';
  }

  // 票が入ったら、このシーズンの集計の使い回しを消す（次に開いた人にすぐ反映）
  if (status === 'counted') {
    const cache = caches.default;
    await Promise.all(
      ['today', 'week', 'season'].flatMap((p) =>
        ['all', 'manga', 'novel'].map((t) => cache.delete(new Request(`https://cache.sukioshi/ranking/${season.id}/${p}/${t}`)))
      )
    );
  }

  // 投票後の「今期ぜんぶ」での順位
  const rows = await countVotes(db, season, season.voteStart, season.voteEnd);
  const mine = rows.find((r) => r.workId === workId);

  const headers = new Headers();
  if (isNewVoter) {
    headers.append('set-cookie', `${COOKIE}=${voter}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`);
  }
  return json({ ok: true, status, rank: mine?.rank ?? null, count: mine?.count ?? 0 }, { headers });
}

export function onRequest() {
  return errorJson(405, 'method_not_allowed', 'POSTで送ってください。');
}
