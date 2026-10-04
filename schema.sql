-- すきおし 投票データベース（Cloudflare D1）
-- 1行 = 1票。投票は消さずに残し、集計はこの表から毎回数える。

CREATE TABLE IF NOT EXISTS votes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  season     TEXT    NOT NULL,           -- 例: 2026-autumn
  work_id    TEXT    NOT NULL,           -- 例: w075
  day        TEXT    NOT NULL,           -- 日本時間の日付 例: 2026-10-05
  voter      TEXT    NOT NULL,           -- 端末ごとのランダムID（Cookie）
  ip_hash    TEXT    NOT NULL,           -- IPアドレスを日替わりの鍵でハッシュ化したもの（元のIPは保存しない）
  created_at INTEGER NOT NULL            -- UNIX時刻（ミリ秒）
);

-- 1作品につき1端末1日1回まで
CREATE UNIQUE INDEX IF NOT EXISTS ux_votes_once ON votes (season, work_id, day, voter);
-- 集計用
CREATE INDEX IF NOT EXISTS ix_votes_season_day ON votes (season, day, work_id);
-- 連打・大量投票の検出用
CREATE INDEX IF NOT EXISTS ix_votes_ip_time ON votes (ip_hash, created_at);
CREATE INDEX IF NOT EXISTS ix_votes_voter_time ON votes (voter, created_at);
