-- 001：会话与权威事件日志
--
-- 只建「存储层自己拥有」的表。领域表（角色、场景、物品……）由各自的
-- 领域包声明，这里不越界。
--
-- 类型映射（对应 DESIGN.md §6.2）：
--   uuid        -> TEXT
--   timestamptz -> INTEGER（毫秒）
--   jsonb       -> TEXT + CHECK(json_valid)
--   boolean     -> INTEGER
--   全部表用 STRICT，避免 SQLite 的类型亲和把 '1' 当字符串存进去。

CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  ruleset_id  TEXT NOT NULL,
  module_id   TEXT,
  title       TEXT NOT NULL DEFAULT '',
  settings    TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(settings))
) STRICT;

-- append-only 权威日志。seq 是会话内的全序，回放按它走。
CREATE TABLE table_events (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq            INTEGER NOT NULL,
  type           TEXT NOT NULL,
  version        INTEGER NOT NULL DEFAULT 1,
  payload        TEXT NOT NULL CHECK (json_valid(payload)),
  visibility     TEXT NOT NULL DEFAULT '{"kind":"public"}' CHECK (json_valid(visibility)),
  actor_seat_id  TEXT,
  turn_id        TEXT,
  client_turn_id TEXT,
  created_at     INTEGER NOT NULL
) STRICT;

CREATE UNIQUE INDEX ux_events_session_seq ON table_events(session_id, seq);
CREATE INDEX ix_events_turn ON table_events(turn_id) WHERE turn_id IS NOT NULL;

-- 幂等：同一个 clientTurnId 重复提交只会落一条。
-- 部分索引让 NULL 不参与唯一性检查（多数事件没有客户端 id）。
CREATE UNIQUE INDEX ux_events_idempotent
  ON table_events(session_id, client_turn_id)
  WHERE client_turn_id IS NOT NULL;
