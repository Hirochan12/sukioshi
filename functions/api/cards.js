// 「みんなのすき」：マイすきカードを公開して、みんなで見られるようにする
//   GET  /api/cards?before=<時刻>   … 公開カードの新しい順（24件ずつ）
//   POST /api/cards { w:[作品ID…], c:"ひとこと" }  … 自分のカードを載せる／更新（1端末1枚）
//   POST /api/cards { remove:true }                … 自分のカードを取り下げる
//   POST /api/cards { report:"カードID" }          … 通報（3人から通報されたカードは自動で非表示）
// 保存するのは作品IDとひとことだけ。楽天のデータ（表紙・商品情報）は保存しない。
import { WORKS, jstDay, json, errorJson, sha256Hex, readCookie } from '../_lib/common.js';

const PAGE = 24;
const MAX_WORKS = 5;
const MAX_COMMENT = 40;
const REPORT_HIDE = 3;        // これだけの人数から通報されたら非表示にする
const LIMIT_IP_PER_DAY = 10;  // 同じ回線から1日に載せられる回数（更新も数える）
const NG_WORDS = ['死ね', '氏ね', '殺す', '殺せ', 'ころす', 'ガイジ', 'キチガイ', '自殺', 'ちんこ', 'まんこ', 'おっぱい', 'セックス', 'レイプ'];

let ready = false;
async function ensureTables(db) {
  if (ready) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS cards (
      id TEXT PRIMARY KEY, voter TEXT NOT NULL UNIQUE, works TEXT NOT NULL, comment TEXT NOT NULL DEFAULT '',
      ip_hash TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, hidden INTEGER NOT NULL DEFAULT 0)`),
    db.prepare('CREATE INDEX IF NOT EXISTS ix_cards_list ON cards (hidden, updated_at)'),
    db.prepare('CREATE INDEX IF NOT EXISTS ix_cards_ip ON cards (ip_hash, updated_at)'),
    db.prepare(`CREATE TABLE IF NOT EXISTS card_reports (
      card_id TEXT NOT NULL, voter TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (card_id, voter))`),
  ]);
  ready = true;
}

const cleanComment = (t) => Array.from(String(t || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim()).slice(0, MAX_COMMENT).join('');

// ひとことに入れてはいけないもの（URL・メール・連絡先・悪口など）。通ればnull、だめなら理由
function badComment(c) {
  const n = c.normalize('NFKC').toLowerCase().replace(/\s/g, '');
  if (/https?:|www\.|\.(com|jp|net|org|io|me|co)\b|@|＠|line|ライン|discord|ディスコ|dm/.test(n)) return 'リンクや連絡先は入れられません。';
  if (/\d{6,}/.test(n)) return '数字が長すぎます。連絡先は入れられません。';
  if (NG_WORDS.some((w) => n.includes(w.normalize('NFKC').toLowerCase()))) return '使えない言葉が入っています。';
  return null;
}

const newId = () => {
  const b = crypto.getRandomValues(new Uint8Array(6));
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
};

export async function onRequestGet({ request, env, waitUntil }) {
  const url = new URL(request.url);
  const before = Number(url.searchParams.get('before')) || 0;
  const cache = caches.default;
  const key = new Request(`https://cache.sukioshi/cards/${before}`);
  const hit = await cache.match(key);
  if (hit) return hit;
  await ensureTables(env.DB);
  const stmt = before
    ? env.DB.prepare('SELECT id, works, comment, updated_at FROM cards WHERE hidden = 0 AND updated_at < ?1 ORDER BY updated_at DESC LIMIT ?2').bind(before, PAGE + 1)
    : env.DB.prepare('SELECT id, works, comment, updated_at FROM cards WHERE hidden = 0 ORDER BY updated_at DESC LIMIT ?1').bind(PAGE + 1);
  const { results } = await stmt.all();
  const more = results.length > PAGE;
  const cards = results.slice(0, PAGE).map((r) => ({
    id: r.id, w: r.works.split(',').filter((id) => WORKS.has(id)), c: r.comment, t: r.updated_at,
  })).filter((c) => c.w.length);
  const res = json({ ok: true, cards, next: more ? results[PAGE - 1].updated_at : null }, { headers: { 'cache-control': 'public, max-age=30' } });
  const put = cache.put(key, res.clone());
  if (waitUntil) waitUntil(put); else await put;
  return res;
}

export async function onRequestPost({ request, env }) {
  const origin = request.headers.get('origin');
  if (origin && new URL(origin).host !== new URL(request.url).host) return errorJson(403, 'bad_origin', '送れませんでした。');
  let body;
  try { body = await request.json(); } catch { return errorJson(400, 'bad_request', '送れませんでした。'); }

  const voter = readCookie(request, 'sk_vid');
  if (!voter || !/^[a-f0-9-]{36}$/.test(voter)) return errorJson(403, 'vote_first', '先に作品の「すき」を押してください。');
  const db = env.DB;
  await ensureTables(db);
  const has = await db.prepare('SELECT 1 AS ok FROM votes WHERE voter = ?1 LIMIT 1').bind(voter).first();
  if (!has) return errorJson(403, 'vote_first', '先に作品の「すき」を押してください。');

  const cache = caches.default;
  const bust = () => cache.delete(new Request('https://cache.sukioshi/cards/0'));

  // 取り下げ
  if (body?.remove) {
    await db.prepare('DELETE FROM cards WHERE voter = ?1').bind(voter).run();
    await bust();
    return json({ ok: true });
  }

  // 通報
  if (body?.report) {
    const id = String(body.report);
    if (!/^[a-f0-9]{12}$/.test(id)) return errorJson(400, 'bad_request', '通報できませんでした。');
    await db.prepare('INSERT OR IGNORE INTO card_reports (card_id, voter, created_at) VALUES (?1, ?2, ?3)').bind(id, voter, Date.now()).run();
    const n = await db.prepare('SELECT COUNT(*) AS n FROM card_reports WHERE card_id = ?1').bind(id).first();
    if (n.n >= REPORT_HIDE) {
      await db.prepare('UPDATE cards SET hidden = 1 WHERE id = ?1').bind(id).run();
      await bust();
    }
    return json({ ok: true });
  }

  // 載せる／更新
  const ids = [...new Set(Array.isArray(body?.w) ? body.w.map(String) : [])].filter((id) => WORKS.has(id)).slice(0, MAX_WORKS);
  if (!ids.length) return errorJson(400, 'no_works', '作品を1つ以上えらんでください。');
  const comment = cleanComment(body?.c);
  const bad = comment && badComment(comment);
  if (bad) return errorJson(400, 'bad_comment', bad);

  const day = jstDay();
  const ip = request.headers.get('cf-connecting-ip') || '0.0.0.0';
  const ipHash = (await sha256Hex(`${env.HASH_SALT || 'sukioshi'}:${day}:${ip}`)).slice(0, 32);
  const since = Date.now() - 24 * 3600 * 1000;
  const cnt = await db.prepare('SELECT COUNT(*) AS n FROM cards WHERE ip_hash = ?1 AND updated_at > ?2').bind(ipHash, since).first();
  if (cnt.n >= LIMIT_IP_PER_DAY) return errorJson(429, 'limited', '今日はもう載せられません。あした、またためしてください。');

  const now = Date.now();
  const mine = await db.prepare('SELECT id, hidden FROM cards WHERE voter = ?1').bind(voter).first();
  if (mine && mine.hidden) return errorJson(403, 'hidden', 'このカードは載せられません。');
  const id = mine ? mine.id : newId();
  await db.prepare(`INSERT INTO cards (id, voter, works, comment, ip_hash, created_at, updated_at, hidden) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, 0)
    ON CONFLICT(voter) DO UPDATE SET works = ?3, comment = ?4, ip_hash = ?5, updated_at = ?6`).bind(id, voter, ids.join(','), comment, ipHash, now).run();
  await bust();
  return json({ ok: true, id });
}

export function onRequest() {
  return errorJson(405, 'method_not_allowed', 'GETかPOSTで送ってください。');
}
