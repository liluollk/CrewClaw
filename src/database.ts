/**
 * SQLite Schema 版本化与三层迁移。
 *
 * 设计要点：
 *  - better-sqlite3 同步 API，单例 db 实例。
 *  - 版本头：router_state 键值表存 schema_version。
 *  - 三层迁移：幂等 DDL → 版本门控数据迁移 → 结构断言。
 *  - PRAGMA 调优：WAL + synchronous=NORMAL + busy_timeout=5000 + temp_store=MEMORY。
 *  - 拒绝降级：库版本 > 代码版本直接拒绝启动。
 *  - 预迁移备份（简版）：v≥2 升级前 VACUUM INTO 备份 + quick_check。
 */
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
export type { DatabaseType };
import { PROJECT_ROOT } from './agent-runtime.js';

// ── 版本常量 ──────────────────────────────────────────────────────────
/** 当前代码期望的 schema 版本。每次新增迁移表/列时 +1。 */
export const CURRENT_SCHEMA_VERSION = 14;

// ── 数据库路径 ─────────────────────────────────────────────────────────
const DB_DIR = path.join(PROJECT_ROOT, 'data', 'db');
const DB_PATH = path.join(DB_DIR, 'miniclaw.db');

// ── 单例 ──────────────────────────────────────────────────────────────
let _db: DatabaseType | null = null;

/** 获取数据库单例（首次调用时初始化并执行迁移）。 */
export function getDatabase(): DatabaseType {
  if (!_db) {
    _db = createDatabase();
    initDatabase(_db);
  }
  return _db;
}

/** 重置单例（仅测试用）。 */
export function resetDatabaseForTest(): void {
  if (_db) {
    try { _db.close(); } catch { /* 已关闭（测试 cleanup 双重 close 的脆弱点加固） */ }
    _db = null;
  }
}

/** 注入单例（仅测试用）：让内部走 getDatabase() 的模块命中临时库。调用方保证已 init。 */
export function setDatabaseForTest(db: DatabaseType): void {
  if (_db && _db !== db) _db.close();
  _db = db;
}

// ── 创建与 PRAGMA 调优 ────────────────────────────────────────────────
function createDatabase(): DatabaseType {
  fs.mkdirSync(DB_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  // PRAGMA 调优
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('temp_store = MEMORY');
  db.pragma('foreign_keys = ON');
  return db;
}

// ── 三层迁移引擎 ──────────────────────────────────────────────────────

/**
 * 第一层：幂等 DDL。
 * 确保 router_state 版本头表存在。
 */
function migrateV1(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS router_state (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  // 写入本迁移对应的版本号（不是 CURRENT_SCHEMA_VERSION——
  // 若写当前头，v1 提交后 v2 失败/崩溃时库会谎称 v2，下次启动跳过迁移导致表永远建不出来）
  const stmt = db.prepare('INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)');
  stmt.run('schema_version', '1');
}

/**
 * P2 迁移 v2：创建产品模型四表 + prompt 版本快照表。
 * agent_profiles / workspaces / workspace_agent_profiles / workspace_runtime_sessions
 * 以及 agent_profile_prompt_versions（不可变快照）。
 */
function migrateV2(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_profiles (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      identity_prompt TEXT NOT NULL DEFAULT '',
      soul_prompt   TEXT NOT NULL DEFAULT '',
      agents_prompt TEXT NOT NULL DEFAULT '',
      tools_prompt  TEXT NOT NULL DEFAULT '',
      runtime_policy TEXT NOT NULL DEFAULT '{}',
      identity_hash TEXT NOT NULL DEFAULT '',
      version       INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS workspaces (
      id        TEXT PRIMARY KEY,
      name      TEXT NOT NULL,
      folder    TEXT NOT NULL UNIQUE,
      owner     TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS workspace_agent_profiles (
      workspace_id      TEXT NOT NULL REFERENCES workspaces(id),
      profile_id        TEXT NOT NULL REFERENCES agent_profiles(id),
      interaction_mode  TEXT NOT NULL DEFAULT 'chat',
      PRIMARY KEY (workspace_id, profile_id)
    );

    CREATE TABLE IF NOT EXISTS workspace_runtime_sessions (
      id            TEXT PRIMARY KEY,
      workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
      profile_id    TEXT NOT NULL REFERENCES agent_profiles(id),
      session_key   TEXT NOT NULL,
      last_used_at  TEXT NOT NULL DEFAULT (datetime('now')),
      metadata      TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS agent_profile_prompt_versions (
      profile_id    TEXT NOT NULL REFERENCES agent_profiles(id),
      version       INTEGER NOT NULL,
      identity_hash TEXT NOT NULL,
      snapshot      TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (profile_id, version)
    );
  `);
  // 更新版本号
  const stmt = db.prepare('INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)');
  stmt.run('schema_version', '2');
}

// 迁移注册表：版本号 → 迁移函数
const MIGRATIONS: Array<{ version: number; fn: (db: DatabaseType) => void }> = [
  { version: 1, fn: migrateV1 },
  { version: 2, fn: migrateV2 },
  { version: 3, fn: migrateV3 },
  { version: 4, fn: migrateV4 },
  { version: 5, fn: migrateV5 },
  { version: 6, fn: migrateV6 },
  { version: 7, fn: migrateV7 },
  { version: 8, fn: migrateV8 },
  { version: 9, fn: migrateV9 },
  { version: 10, fn: migrateV10 },
  { version: 11, fn: migrateV11 },
  { version: 12, fn: migrateV12 },
  { version: 13, fn: migrateV13 },
  { version: 14, fn: migrateV14 },
];

/**
 * P5 迁移 v3：Workspace Memory 表族（store/item/version/tombstone/FTS）。
 * 边界：结构化知识 + FTS 全文检索，**没有向量检索能力**（不是 RAG）。
 */
function migrateV3(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_memory_stores (
      id           TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL UNIQUE,
      revision     INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS workspace_memory_items (
      id              TEXT PRIMARY KEY,
      store_id        TEXT NOT NULL REFERENCES workspace_memory_stores(id),
      kind            TEXT NOT NULL CHECK (kind IN ('fact','decision','lesson','open_loop')),
      title           TEXT NOT NULL DEFAULT '',
      content         TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','deleted')),
      importance      REAL NOT NULL DEFAULT 0.5 CHECK (importance >= 0 AND importance <= 1),
      confidence      REAL NOT NULL DEFAULT 1   CHECK (confidence >= 0 AND confidence <= 1),
      revision        INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
      idempotency_key TEXT,
      request_hash    TEXT NOT NULL DEFAULT '',
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_idempotency
      ON workspace_memory_items (store_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL;

    CREATE TABLE IF NOT EXISTS workspace_memory_versions (
      item_id     TEXT NOT NULL REFERENCES workspace_memory_items(id),
      revision    INTEGER NOT NULL,
      change_type TEXT NOT NULL CHECK (change_type IN ('create','update','forget')),
      snapshot    TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (item_id, revision)
    );

    CREATE TABLE IF NOT EXISTS workspace_memory_tombstones (
      item_id         TEXT PRIMARY KEY REFERENCES workspace_memory_items(id),
      deleted_revision INTEGER NOT NULL,
      reason          TEXT NOT NULL DEFAULT '',
      actor           TEXT NOT NULL DEFAULT '',
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS workspace_memory_fts USING fts5(
      title, content,
      item_id UNINDEXED,
      store_id UNINDEXED,
      tokenize = 'trigram'
    );

    INSERT OR REPLACE INTO router_state (key, value) VALUES ('schema_version', '3');
  `);
}

/**
 * v3→v4：对话历史底账 chat_messages。
 * 按复合会话键存每一轮的用户/助手/工具/系统消息——刷新不丢、跨渠道可查。
 */
function migrateV4(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id          TEXT PRIMARY KEY,
      session_key TEXT NOT NULL,
      role        TEXT NOT NULL CHECK (role IN ('user','assistant','tool','system')),
      content     TEXT NOT NULL,
      meta        TEXT NOT NULL DEFAULT '{}',
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_chat_messages_session
      ON chat_messages (session_key, created_at);

    INSERT OR REPLACE INTO router_state (key, value) VALUES ('schema_version', '4');
  `);
}

/**
 * v4→v5：多用户。users + web_sessions（R21-lite 认证地基）。
 * 认证语义：库里只存登录凭证的 scrypt 哈希与随机会话 token；
 * 下发的 cookie 是 token.HMAC-SHA256(token, secret)——拖库也拿不到可复用的登录态。
 */
function migrateV5(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      display_name  TEXT NOT NULL DEFAULT '',
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS web_sessions (
      token      TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_web_sessions_user ON web_sessions (user_id);

    INSERT OR REPLACE INTO router_state (key, value) VALUES ('schema_version', '5');
  `);
}

/**
 * v5→v6：渠道多用户。每个工作区可配置自己的 IM 渠道凭据。
 * credentials 为 AES-256-GCM 密文（iv.tag.ct hex）——拖库拿不到明文凭据；
 * 同一工作区每类渠道至多一条（UNIQUE），启用开关独立于凭据存在。
 */
function migrateV6(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_channels (
      id           TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      kind         TEXT NOT NULL CHECK (kind IN ('feishu','dingtalk')),
      account_id   TEXT NOT NULL DEFAULT '',
      credentials  TEXT NOT NULL DEFAULT '',
      enabled      INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (workspace_id, kind)
    );

    INSERT OR REPLACE INTO router_state (key, value) VALUES ('schema_version', '6');
  `);
}

/**
 * v6→v7：定时任务（单实例调度器，R14 思想的单进程收窄）。
 *  - scheduled_tasks.next_run_at 兼任调度游标与乐观锁：领取运行 = 单事务内
 *    「游标比对 → 物化 task_runs → 推进游标」，重复触发被比对挡住。
 *  - task_runs.occurrence_key = taskId:scheduledFor 全局唯一：同一次触达至多一条运行。
 *  - definition 快照冻结执行瞬间的任务定义，改配置不影响已在跑的一轮。
 *  - 多实例租约 fencing（lease_token/心跳续租）为多进程部署语义，单进程实现刻意不做。
 */
function migrateV7(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id            TEXT PRIMARY KEY,
      workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
      name          TEXT NOT NULL,
      prompt        TEXT NOT NULL,
      schedule_json TEXT NOT NULL,
      enabled       INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
      next_run_at   TEXT,
      last_run_at   TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_due ON scheduled_tasks (enabled, next_run_at);

    CREATE TABLE IF NOT EXISTS task_runs (
      id             TEXT PRIMARY KEY,
      task_id        TEXT NOT NULL REFERENCES scheduled_tasks(id),
      occurrence_key TEXT NOT NULL UNIQUE,
      status         TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','failed','missed')),
      result_text    TEXT NOT NULL DEFAULT '',
      snapshot       TEXT NOT NULL DEFAULT '{}',
      started_at     TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at    TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_task_runs_task ON task_runs (task_id, started_at);

    INSERT OR REPLACE INTO router_state (key, value) VALUES ('schema_version', '7');
  `);
}

/**
 * v7→v8：Agent 工具调用审计底账。
 *  - 每次工具调用（无论是否经权限确认）落一条记录，含 agent_id / workspace_id /
 *    session_key / trigger_type，回答"哪个 Agent 在什么触发下做了什么"。
 *  - status 四态：pending（待确认）/ approved（确认后执行）/ rejected（拒绝）/
 *    auto（readonly 直通）。
 *  - 工具侧调用 recordToolCall() 写入；本表不参与运行时判定，只做审计。
 */
function migrateV8(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_calls (
      id           TEXT PRIMARY KEY,
      agent_id     TEXT NOT NULL DEFAULT '',
      workspace_id TEXT NOT NULL DEFAULT '',
      session_key  TEXT NOT NULL DEFAULT '',
      tool_name    TEXT NOT NULL,
      input        TEXT NOT NULL DEFAULT '{}',
      status       TEXT NOT NULL DEFAULT 'auto' CHECK (status IN ('pending','approved','rejected','auto')),
      result_text  TEXT NOT NULL DEFAULT '',
      trigger_type TEXT NOT NULL DEFAULT 'message',
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_tool_calls_agent ON tool_calls (agent_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_tool_calls_workspace ON tool_calls (workspace_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls (session_key, created_at);

    INSERT OR REPLACE INTO router_state (key, value) VALUES ('schema_version', '8');
  `);
}

// 迁移 v9：tool_calls.status CHECK 约束扩展（增加 executed/error）
function migrateV9(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_calls_v9 (
      id           TEXT PRIMARY KEY,
      agent_id     TEXT NOT NULL DEFAULT '',
      workspace_id TEXT NOT NULL DEFAULT '',
      session_key  TEXT NOT NULL DEFAULT '',
      tool_name    TEXT NOT NULL,
      input        TEXT NOT NULL DEFAULT '{}',
      status       TEXT NOT NULL DEFAULT 'auto' CHECK (status IN ('pending','approved','rejected','auto','executed','error')),
      result_text  TEXT NOT NULL DEFAULT '',
      trigger_type TEXT NOT NULL DEFAULT 'message',
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    INSERT INTO tool_calls_v9 SELECT * FROM tool_calls;
    DROP TABLE tool_calls;
    ALTER TABLE tool_calls_v9 RENAME TO tool_calls;

    CREATE INDEX IF NOT EXISTS idx_tool_calls_agent ON tool_calls (agent_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_tool_calls_workspace ON tool_calls (workspace_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls (session_key, created_at);

    INSERT OR REPLACE INTO router_state (key, value) VALUES ('schema_version', '9');
  `);
}

/**
 * v9→v10：Workspace 成员关系。
 * 旧模型用 workspaces.owner 表示一人一空间；升级时把 owner 回填为 owner 成员，
 * 新模型允许一个 Workspace 关联多个用户。
 */
function migrateV10(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_members (
      id           TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role         TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (workspace_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_workspace_members_user
      ON workspace_members (user_id, workspace_id);

    INSERT OR IGNORE INTO workspace_members (id, workspace_id, user_id, role)
      SELECT 'wm-owner-' || id || '-' || owner, id, owner, 'owner'
      FROM workspaces
      WHERE owner IS NOT NULL AND owner <> '';

    INSERT OR REPLACE INTO router_state (key, value) VALUES ('schema_version', '10');
  `);
}

/**
 * v10→v11：记忆作用域。
 * 旧记忆默认是 Workspace 共享；新写入可限定到当前 conversation。
 */
function migrateV11(db: DatabaseType): void {
  ensureColumn(
    db,
    'workspace_memory_items',
    'scope_type',
    "ALTER TABLE workspace_memory_items ADD COLUMN scope_type TEXT NOT NULL DEFAULT 'workspace' CHECK (scope_type IN ('workspace','conversation'))",
  );
  ensureColumn(
    db,
    'workspace_memory_items',
    'scope_key',
    'ALTER TABLE workspace_memory_items ADD COLUMN scope_key TEXT',
  );
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memory_scope
      ON workspace_memory_items (store_id, scope_type, scope_key);

    INSERT OR REPLACE INTO router_state (key, value) VALUES ('schema_version', '11');
  `);
}

/**
 * v11→v12：Web Session 记录当前活动 Workspace，支持一个用户加入多个团队后切换空间。
 */
function migrateV12(db: DatabaseType): void {
  ensureColumn(
    db,
    'web_sessions',
    'workspace_id',
    'ALTER TABLE web_sessions ADD COLUMN workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL',
  );
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_web_sessions_workspace
      ON web_sessions (workspace_id);

    INSERT OR REPLACE INTO router_state (key, value) VALUES ('schema_version', '12');
  `);
}

/** v12→v13：工具审计补充操作人，区分“哪个成员触发了 Agent 行为”。 */
function migrateV13(db: DatabaseType): void {
  ensureColumn(
    db,
    'tool_calls',
    'actor_user_id',
    "ALTER TABLE tool_calls ADD COLUMN actor_user_id TEXT NOT NULL DEFAULT ''",
  );
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tool_calls_actor
      ON tool_calls (actor_user_id, created_at);

    INSERT OR REPLACE INTO router_state (key, value) VALUES ('schema_version', '13');
  `);
}

/** v13→v14：全局应用设置 KV（模型接入等平台级配置；凭据经 secret-box 加密落库）。 */
function migrateV14(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT OR REPLACE INTO router_state (key, value) VALUES ('schema_version', '14');
  `);
}

/**
 * 第一层工具：幂等补列。
 * 检查表是否存在某列，不存在则执行 ddl。
 */
export function ensureColumn(db: DatabaseType, table: string, column: string, ddl: string): void {
  const row = db.prepare(
    `SELECT COUNT(*) AS cnt FROM pragma_table_info(?) WHERE name = ?`,
  ).get(table, column) as { cnt: number } | undefined;
  if (!row || row.cnt === 0) {
    db.exec(ddl);
  }
}

/**
 * 第三层：结构断言。
 * 检查必需列存在、禁止列不存在，否则 fail-fast。
 */
export function assertSchema(
  db: DatabaseType,
  table: string,
  requiredColumns: string[],
  forbiddenColumns: string[],
): void {
  const rows = db.prepare('SELECT name FROM pragma_table_info(?)').all(table) as Array<{ name: string }>;
  const existing = new Set(rows.map(r => r.name));
  for (const col of requiredColumns) {
    if (!existing.has(col)) {
      throw new Error(`结构断言失败：表 ${table} 缺少必需列 ${col}`);
    }
  }
  for (const col of forbiddenColumns) {
    if (existing.has(col)) {
      throw new Error(`结构断言失败：表 ${table} 包含禁止列 ${col}`);
    }
  }
}

/**
 * 获取当前库的 schema 版本。
 * 库不存在或表不存在时返回 0。
 */
function getCurrentSchemaVersion(db: DatabaseType): number {
  try {
    const row = db.prepare("SELECT value FROM router_state WHERE key = 'schema_version'").get() as
      | { value: string }
      | undefined;
    return row ? Number(row.value) || 0 : 0;
  } catch {
    // router_state 表还不存在
    return 0;
  }
}

/**
 * 预迁移备份（简版）：VACUUM INTO 备份 + quick_check。
 * 仅从 v1 升级到 v≥2 时执行（空库 v0 无需备份）。
 */
function backupBeforeMigration(db: DatabaseType, fromVersion: number, toVersion: number): void {
  if (fromVersion >= 1 && fromVersion < 2 && toVersion >= 2) {
    // 备份跟随被迁移的库文件（而非全局目录）——测试迁移临时库时不会污染真实 data 目录
    const backupDir = path.join(path.dirname(db.name), 'backup');
    fs.mkdirSync(backupDir, { recursive: true });
    const timestamp = Date.now();
    const uniqueId = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    const backupPath = path.join(backupDir, `miniclaw-v${fromVersion}-pre${toVersion}-${timestamp}-${uniqueId}.db`);
    console.log(`[db] 预迁移备份：${fromVersion}→${toVersion} → ${backupPath}`);
    // SQLite 字符串字面量中反斜杠不是转义符，正确做法是转义单引号
    db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
    const checkDb = new Database(backupPath);
    try {
      const result = checkDb.prepare('PRAGMA quick_check').get() as { 'quick_check': string } | undefined;
      if (result && result['quick_check'] !== 'ok') {
        throw new Error(`备份完整性检查失败：${JSON.stringify(result)}`);
      }
      console.log('[db] 备份完整性检查通过');
    } finally {
      checkDb.close();
    }
  }
}

/**
 * 初始化数据库：执行迁移管线。
 * 幂等——二次启动不重复执行已应用的迁移。
 */
export function initDatabase(db: DatabaseType): void {
  const curVer = getCurrentSchemaVersion(db);

  // 拒绝降级
  if (curVer > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `数据库版本 (v${curVer}) 高于代码版本 (v${CURRENT_SCHEMA_VERSION})，` +
      `拒绝降级启动。请升级代码或重建数据库。`,
    );
  }

  if (curVer === CURRENT_SCHEMA_VERSION) {
    console.log(`[db] schema 已是最新 (v${CURRENT_SCHEMA_VERSION})，跳过迁移`);
    return;
  }

  // 按版本顺序执行未完成的迁移
  let effectiveCurVer = curVer;
  for (const m of MIGRATIONS) {
    if (m.version > effectiveCurVer && m.version <= CURRENT_SCHEMA_VERSION) {
      // 预迁移备份
      backupBeforeMigration(db, effectiveCurVer, m.version);
      // 版本门控迁移（事务包裹）
      db.transaction(() => {
        console.log(`[db] 执行迁移 v${m.version}...`);
        m.fn(db);
      })();
      console.log(`[db] 迁移 v${m.version} 完成`);
      effectiveCurVer = m.version;
    }
  }

  // 结构断言（fail-fast）：迁移声称完成后，核心表必须真实存在。
  // 防御 BUG3 类场景：版本头谎报完成但表未建。
  const expectedTables = ['router_state', 'agent_profiles', 'workspaces', 'workspace_members', 'workspace_agent_profiles', 'workspace_runtime_sessions', 'agent_profile_prompt_versions', 'workspace_memory_stores', 'workspace_memory_items', 'workspace_memory_versions', 'workspace_memory_tombstones', 'chat_messages', 'users', 'web_sessions', 'workspace_channels', 'scheduled_tasks', 'task_runs', 'tool_calls'];
  for (const table of expectedTables) {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(table) as { name: string } | undefined;
    if (!row) {
      throw new Error(`结构断言失败：版本头为 v${CURRENT_SCHEMA_VERSION} 但表 ${table} 不存在，请删除 ${DB_PATH} 后重启`);
    }
  }

  // 最终断言：当前版本已写入
  const finalVer = getCurrentSchemaVersion(db);
  if (finalVer !== CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `迁移后版本不一致：期望 v${CURRENT_SCHEMA_VERSION}，实际 v${finalVer}`,
    );
  }
}
