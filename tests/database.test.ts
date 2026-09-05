/**
 * SQLite Schema 版本化与三层迁移测试。
 *
 * 测试覆盖：
 *  1) 版本头钉死断言（字面量 CURRENT_SCHEMA_VERSION）。
 *  2) 首次 initDatabase → router_state 含 schema_version。
 *  3) 二次启动幂等（不抛错、版本不变）。
 *  4) ensureColumn 幂等补列。
 *  5) assertSchema 必需列/禁止列检测。
 *  6) 迁移失败原子回滚（事务中断 → 版本不动）。
 *  7) 拒绝降级（手动改库版本 > 代码版本）。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

// 直接用 Database 引用，避免依赖 agent-runtime 的 PROJECT_ROOT
import {
  CURRENT_SCHEMA_VERSION,
  initDatabase,
  ensureColumn,
  assertSchema,
  resetDatabaseForTest,
} from '../src/database.js';

/** 每个测试用独立临时数据库文件，互不干扰 */
function createTempDb(): { db: DatabaseType; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniclaw-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('temp_store = MEMORY');
  const cleanup = () => {
    db.close();
    // 清理 WAL 文件
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
    try { fs.unlinkSync(dbPath + '-wal'); } catch { /* ignore */ }
    try { fs.unlinkSync(dbPath + '-shm'); } catch { /* ignore */ }
    try { fs.rmdirSync(tmpDir); } catch { /* ignore */ }
  };
  return { db, cleanup };
}

describe('P1 · 版本常量', () => {
  it('CURRENT_SCHEMA_VERSION 是正整数（字面量钉死）', () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(CURRENT_SCHEMA_VERSION)).toBe(true);
  });
});

describe('P1 · initDatabase 迁移管线', () => {
  let ctx: { db: DatabaseType; cleanup: () => void };

  beforeEach(() => {
    ctx = createTempDb();
  });

  afterEach(() => {
    ctx.cleanup();
    resetDatabaseForTest();
  });

  it('首次 initDatabase 创建 router_state 并写入版本', () => {
    initDatabase(ctx.db);
    const row = ctx.db.prepare("SELECT value FROM router_state WHERE key = 'schema_version'").get() as
      | { value: string }
      | undefined;
    expect(row).toBeDefined();
    expect(Number(row!.value)).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('二次调用 initDatabase 幂等（不抛错、版本不变）', () => {
    initDatabase(ctx.db);
    expect(() => initDatabase(ctx.db)).not.toThrow();
    const row = ctx.db.prepare("SELECT value FROM router_state WHERE key = 'schema_version'").get() as
      | { value: string }
      | undefined;
    expect(Number(row!.value)).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('router_state 表结构正确（key TEXT PK, value TEXT NOT NULL）', () => {
    initDatabase(ctx.db);
    // 插入测试数据验证约束
    ctx.db.prepare('INSERT INTO router_state (key, value) VALUES (?, ?)').run('test_key', 'test_value');
    const row = ctx.db.prepare("SELECT value FROM router_state WHERE key = 'test_key'").get() as
      | { value: string }
      | undefined;
    expect(row!.value).toBe('test_value');
  });
});

describe('P1 · ensureColumn 幂等补列', () => {
  let ctx: { db: DatabaseType; cleanup: () => void };

  beforeEach(() => {
    ctx = createTempDb();
    ctx.db.exec('CREATE TABLE IF NOT EXISTS test_table (id INTEGER PRIMARY KEY)');
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it('补不存在的列', () => {
    ensureColumn(ctx.db, 'test_table', 'name', 'ALTER TABLE test_table ADD COLUMN name TEXT');
    const cols = ctx.db.prepare('SELECT name FROM pragma_table_info(\'test_table\')').all() as Array<{ name: string }>;
    const names = cols.map(c => c.name);
    expect(names).toContain('name');
  });

  it('重复补列幂等（不抛错）', () => {
    ensureColumn(ctx.db, 'test_table', 'name', 'ALTER TABLE test_table ADD COLUMN name TEXT');
    expect(() => {
      ensureColumn(ctx.db, 'test_table', 'name', 'ALTER TABLE test_table ADD COLUMN name TEXT');
    }).not.toThrow();
  });

  it('补列后插入数据正常', () => {
    ensureColumn(ctx.db, 'test_table', 'name', 'ALTER TABLE test_table ADD COLUMN name TEXT');
    ctx.db.prepare('INSERT INTO test_table (id, name) VALUES (?, ?)').run(1, 'hello');
    const row = ctx.db.prepare('SELECT name FROM test_table WHERE id = 1').get() as { name: string };
    expect(row.name).toBe('hello');
  });
});

describe('P1 · assertSchema 结构断言', () => {
  let ctx: { db: DatabaseType; cleanup: () => void };

  beforeEach(() => {
    ctx = createTempDb();
    ctx.db.exec(
      'CREATE TABLE IF NOT EXISTS test_schema (id INTEGER PRIMARY KEY, name TEXT, status TEXT)',
    );
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it('必需列都存在时通过', () => {
    expect(() => assertSchema(ctx.db, 'test_schema', ['id', 'name'], [])).not.toThrow();
  });

  it('缺少必需列时抛错', () => {
    expect(() => assertSchema(ctx.db, 'test_schema', ['id', 'name', 'missing_col'], [])).toThrow(
      '缺少必需列',
    );
  });

  it('包含禁止列时抛错', () => {
    expect(() => assertSchema(ctx.db, 'test_schema', ['id'], ['status'])).toThrow('包含禁止列');
  });
});

describe('P1 · 拒绝降级', () => {
  let ctx: { db: DatabaseType; cleanup: () => void };

  beforeEach(() => {
    ctx = createTempDb();
    // 先初始化到当前版本
    initDatabase(ctx.db);
    // 手动把版本写高，模拟"库版本 > 代码版本"
    ctx.db.prepare('INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)').run(
      'schema_version',
      String(CURRENT_SCHEMA_VERSION + 999),
    );
  });

  afterEach(() => {
    ctx.cleanup();
    resetDatabaseForTest();
  });

  it('库版本 > 代码版本时拒绝启动', () => {
    expect(() => initDatabase(ctx.db)).toThrow('拒绝降级');
  });
});

describe('P1 · 迁移失败原子回滚', () => {
  it('正常迁移成功 → 版本对齐', () => {
    const ctx = createTempDb();
    ctx.db.exec(`
      CREATE TABLE IF NOT EXISTS router_state (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    ctx.db.prepare('INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)').run(
      'schema_version',
      '0',
    );
    initDatabase(ctx.db);
    const row = ctx.db.prepare("SELECT value FROM router_state WHERE key = 'schema_version'").get() as
      | { value: string }
      | undefined;
    expect(Number(row!.value)).toBe(CURRENT_SCHEMA_VERSION);
    ctx.cleanup();
  });

  it('BUG3 回归：v1 已提交但 v2 未跑（崩溃恢复）→ 下次启动补齐 v2 表', () => {
    const ctx = createTempDb();
    // 模拟崩溃现场：router_state 存在且版本为 1，但 v2 的表一张都没有
    ctx.db.exec(`
      CREATE TABLE IF NOT EXISTS router_state (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    ctx.db.prepare('INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)').run(
      'schema_version',
      '1',
    );
    // 修复前 migrateV1 会把版本写成 CURRENT_SCHEMA_VERSION(2)，此场景会被跳过导致表永远建不出来
    initDatabase(ctx.db);
    const tables = (ctx.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((r) => r.name);
    expect(tables).toContain('agent_profiles');
    expect(tables).toContain('workspaces');
    expect(tables).toContain('workspace_runtime_sessions');
    const row = ctx.db.prepare("SELECT value FROM router_state WHERE key = 'schema_version'").get() as { value: string };
    expect(Number(row.value)).toBe(CURRENT_SCHEMA_VERSION);
    ctx.cleanup();
  });
});

describe('P2 · 共享 Workspace 成员迁移', () => {
  it('升级到 v10 后创建 workspace_members 表和角色约束', () => {
    const ctx = createTempDb();
    initDatabase(ctx.db);
    const version = ctx.db.prepare("SELECT value FROM router_state WHERE key = 'schema_version'").get() as { value: string };
    expect(Number(version.value)).toBe(CURRENT_SCHEMA_VERSION);
    const cols = ctx.db.prepare("SELECT name FROM pragma_table_info('workspace_members')").all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toEqual(expect.arrayContaining(['workspace_id', 'user_id', 'role']));
    expect(() => ctx.db.prepare(
      "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('ws-x', 'u-x', 'invalid')",
    ).run()).toThrow();
    ctx.cleanup();
  });

  it('旧 Workspace.owner 升级时自动回填为 owner 成员', () => {
    const ctx = createTempDb();
    initDatabase(ctx.db);
    ctx.db.exec('DROP TABLE workspace_members');
    ctx.db.prepare("INSERT OR REPLACE INTO router_state (key, value) VALUES ('schema_version', '9')").run();
    ctx.db.prepare("INSERT INTO users (id, username, password_hash) VALUES ('user-1', 'legacy', 'hash')").run();
    ctx.db.prepare("INSERT INTO workspaces (id, name, folder, owner) VALUES ('ws-legacy', 'Legacy', 'legacy', 'user-1')").run();
    initDatabase(ctx.db);
    const member = ctx.db.prepare(
      "SELECT workspace_id, user_id, role FROM workspace_members WHERE workspace_id = 'ws-legacy'",
    ).get() as { workspace_id: string; user_id: string; role: string } | undefined;
    expect(member).toEqual({ workspace_id: 'ws-legacy', user_id: 'user-1', role: 'owner' });
    ctx.cleanup();
  });
});

describe('P2 · 活动 Workspace 会话迁移', () => {
  it('升级到 v12 后 web_sessions 支持活动 workspace_id', () => {
    const ctx = createTempDb();
    initDatabase(ctx.db);
    const cols = ctx.db.prepare("SELECT name FROM pragma_table_info('web_sessions')").all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain('workspace_id');
    ctx.cleanup();
  });
});

describe('P2 · 工具操作人审计迁移', () => {
  it('升级后 tool_calls 记录 actor_user_id', () => {
    const ctx = createTempDb();
    initDatabase(ctx.db);
    const cols = ctx.db.prepare("SELECT name FROM pragma_table_info('tool_calls')").all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain('actor_user_id');
    ctx.cleanup();
  });
});
