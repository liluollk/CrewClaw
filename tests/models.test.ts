/**
 * 三层产品模型与身份哈希测试。
 *
 * 测试覆盖：
 *  1) 建 Profile / 建 Workspace / 绑定桥接。
 *  2) 改提示词 → hash 变化 + version+1 + 不可变快照落库。
 *  3) 非法 folder 拒绝创建。
 *  4) 多 Profile 隔离（hash 不串）。
 *  5) Folder 正则校验函数正确性。
 *  6) computeIdentityHash 确定性。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { initDatabase, resetDatabaseForTest } from '../src/database.js';
import {
  createAgentProfile,
  getAgentProfile,
  listAgentProfiles,
  updateAgentProfile,
  createWorkspace,
  getWorkspace,
  getWorkspaceByFolder,
  listWorkspaces,
  bindProfileToWorkspace,
  getBindingsForWorkspace,
  recordRuntimeSession,
  getRuntimeSessionByKey,
  listRuntimeSessions,
  getPromptVersionSnapshots,
  computeIdentityHash,
  validateFolder,
  FOLDER_PATTERN,
  assertProductModelSchema,
  recordToolCall,
  listToolCalls,
} from '../src/models.js';

function createTempDb(): { db: DatabaseType; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniclaw-model-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('temp_store = MEMORY');
  db.pragma('foreign_keys = ON');
  initDatabase(db);
  const cleanup = () => {
    db.close();
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
    try { fs.unlinkSync(dbPath + '-wal'); } catch { /* ignore */ }
    try { fs.unlinkSync(dbPath + '-shm'); } catch { /* ignore */ }
    try { fs.rmdirSync(tmpDir); } catch { /* ignore */ }
  };
  return { db, cleanup };
}

describe('P2 · Folder 校验', () => {
  it('合法 folder 通过', () => {
    expect(validateFolder('hello')).toBe(true);
    expect(validateFolder('my-workspace')).toBe(true);
    expect(validateFolder('test.folder_1')).toBe(true);
    expect(validateFolder('A')).toBe(true);
    expect(validateFolder('a'.repeat(128))).toBe(true);
  });

  it('非法 folder 拒绝', () => {
    expect(validateFolder('')).toBe(false);
    expect(validateFolder('.hidden')).toBe(false);
    expect(validateFolder('_underscore')).toBe(false);
    expect(validateFolder('has space')).toBe(false);
    expect(validateFolder('has/ slash')).toBe(false);
    expect(validateFolder('has\\ backslash')).toBe(false);
    expect(validateFolder('a'.repeat(129))).toBe(false);
    expect(validateFolder('../traversal')).toBe(false);
  });

  it('FOLDER_PATTERN 正则正确', () => {
    expect(FOLDER_PATTERN.test('valid-folder_1.2')).toBe(true);
    expect(FOLDER_PATTERN.test('../../etc')).toBe(false);
  });
});

describe('P2 · computeIdentityHash', () => {
  it('相同输入产生相同 hash（确定性）', () => {
    const a = computeIdentityHash({
      name: 'test',
      identityPrompt: '你是一个助手',
      soulPrompt: '',
      agentsPrompt: '',
      toolsPrompt: '',
      runtimePolicy: {},
    });
    const b = computeIdentityHash({
      name: 'test',
      identityPrompt: '你是一个助手',
      soulPrompt: '',
      agentsPrompt: '',
      toolsPrompt: '',
      runtimePolicy: {},
    });
    expect(a).toBe(b);
  });

  it('不同输入产生不同 hash', () => {
    const a = computeIdentityHash({
      name: 'test',
      identityPrompt: '你是一个助手',
      soulPrompt: '',
      agentsPrompt: '',
      toolsPrompt: '',
      runtimePolicy: {},
    });
    const b = computeIdentityHash({
      name: 'test2',
      identityPrompt: '你是一个助手',
      soulPrompt: '',
      agentsPrompt: '',
      toolsPrompt: '',
      runtimePolicy: {},
    });
    expect(a).not.toBe(b);
  });

  it('改 runtimePolicy 改变 hash', () => {
    const a = computeIdentityHash({
      name: 'test', identityPrompt: '', soulPrompt: '',
      agentsPrompt: '', toolsPrompt: '', runtimePolicy: { mode: 'chat' },
    });
    const b = computeIdentityHash({
      name: 'test', identityPrompt: '', soulPrompt: '',
      agentsPrompt: '', toolsPrompt: '', runtimePolicy: { mode: 'agent' },
    });
    expect(a).not.toBe(b);
  });

  it('BUG2 回归：嵌套 runtimePolicy 变更必须改变 hash', () => {
    const base = { name: 'test', identityPrompt: '', soulPrompt: '', agentsPrompt: '', toolsPrompt: '' };
    const a = computeIdentityHash({ ...base, runtimePolicy: { skills: { enabled: true } } });
    const b = computeIdentityHash({ ...base, runtimePolicy: { skills: { enabled: false } } });
    // 修复前 JSON.stringify replacer 数组会丢弃嵌套键，a === b（身份变更失明）
    expect(a).not.toBe(b);
  });

  it('BUG2 回归：嵌套键顺序不同但内容相同 → hash 相同（确定性）', () => {
    const base = { name: 'test', identityPrompt: '', soulPrompt: '', agentsPrompt: '', toolsPrompt: '' };
    const a = computeIdentityHash({ ...base, runtimePolicy: { skills: { a: 1, b: 2 } } });
    const b = computeIdentityHash({ ...base, runtimePolicy: { skills: { b: 2, a: 1 } } });
    expect(a).toBe(b);
  });
});

describe('P2 · AgentProfile CRUD', () => {
  let ctx: { db: DatabaseType; cleanup: () => void };

  beforeEach(() => {
    ctx = createTempDb();
  });

  afterEach(() => {
    ctx.cleanup();
    resetDatabaseForTest();
  });

  it('创建 Profile → 返回完整对象，包含 hash 和 version=1', () => {
    const p = createAgentProfile(ctx.db, {
      id: 'prof-1',
      name: '助手A',
      identityPrompt: '你是一个助手',
    });
    expect(p.id).toBe('prof-1');
    expect(p.name).toBe('助手A');
    expect(p.version).toBe(1);
    expect(p.identityHash).toBeTruthy();
    expect(p.identityHash.length).toBe(64); // SHA-256 hex
  });

  it('getAgentProfile 按 id 查询', () => {
    createAgentProfile(ctx.db, { id: 'prof-1', name: '助手A' });
    const p = getAgentProfile(ctx.db, 'prof-1');
    expect(p).not.toBeNull();
    expect(p!.name).toBe('助手A');
  });

  it('listAgentProfiles 列出所有', () => {
    createAgentProfile(ctx.db, { id: 'prof-1', name: 'A' });
    createAgentProfile(ctx.db, { id: 'prof-2', name: 'B' });
    const list = listAgentProfiles(ctx.db);
    expect(list.length).toBe(2);
  });

  it('不存在的 Profile 返回 null', () => {
    expect(getAgentProfile(ctx.db, 'nonexistent')).toBeNull();
  });
});

describe('P2 · 身份变更 → hash 变化 + version+1 + 快照', () => {
  let ctx: { db: DatabaseType; cleanup: () => void };

  beforeEach(() => {
    ctx = createTempDb();
  });

  afterEach(() => {
    ctx.cleanup();
    resetDatabaseForTest();
  });

  it('改提示词 → hash 变化 + version+1', () => {
    const p = createAgentProfile(ctx.db, {
      id: 'prof-1',
      name: '助手A',
      identityPrompt: '初始身份',
    });
    const oldHash = p.identityHash;
    const oldVer = p.version;

    const updated = updateAgentProfile(ctx.db, 'prof-1', {
      identityPrompt: '新版身份',
    });
    expect(updated!.identityHash).not.toBe(oldHash);
    expect(updated!.version).toBe(oldVer + 1);
  });

  it('改 name → hash 变化 + version+1', () => {
    const p = createAgentProfile(ctx.db, {
      id: 'prof-1', name: '原名',
    });
    const updated = updateAgentProfile(ctx.db, 'prof-1', { name: '新名' });
    expect(updated!.version).toBe(p.version + 1);
  });

  it('内容无变化 → version 不变', () => {
    createAgentProfile(ctx.db, {
      id: 'prof-1', name: 'A', identityPrompt: '身份',
    });
    const updated = updateAgentProfile(ctx.db, 'prof-1', {
      name: 'A', identityPrompt: '身份',
    });
    expect(updated!.version).toBe(1); // 不变
  });

  it('不可变快照落库：每次变更写入一条', () => {
    createAgentProfile(ctx.db, {
      id: 'prof-1', name: 'A', identityPrompt: 'v1',
    });
    updateAgentProfile(ctx.db, 'prof-1', { identityPrompt: 'v2' });
    updateAgentProfile(ctx.db, 'prof-1', { identityPrompt: 'v3' });

    const snapshots = getPromptVersionSnapshots(ctx.db, 'prof-1');
    expect(snapshots.length).toBe(3);
    expect(snapshots[0].version).toBe(3); // DESC 排序
    expect(snapshots[2].version).toBe(1);
  });

  it('快照包含完整 prompt 内容', () => {
    createAgentProfile(ctx.db, {
      id: 'prof-1', name: 'A', identityPrompt: '你好',
    });
    const snapshots = getPromptVersionSnapshots(ctx.db, 'prof-1');
    const snap = JSON.parse(snapshots[0].snapshot);
    expect(snap.identityPrompt).toBe('你好');
  });
});

describe('P2 · Workspace CRUD', () => {
  let ctx: { db: DatabaseType; cleanup: () => void };

  beforeEach(() => {
    ctx = createTempDb();
  });

  afterEach(() => {
    ctx.cleanup();
    resetDatabaseForTest();
  });

  it('创建 Workspace', () => {
    const w = createWorkspace(ctx.db, { id: 'ws-1', name: '测试空间', folder: 'test-ws' });
    expect(w.id).toBe('ws-1');
    expect(w.folder).toBe('test-ws');
  });

  it('非法 folder 拒绝创建', () => {
    expect(() => {
      createWorkspace(ctx.db, { id: 'ws-1', name: '坏', folder: '../evil' });
    }).toThrow('非法 folder');
  });

  it('按 folder 查询', () => {
    createWorkspace(ctx.db, { id: 'ws-1', name: 'A', folder: 'my-folder' });
    const w = getWorkspaceByFolder(ctx.db, 'my-folder');
    expect(w).not.toBeNull();
    expect(w!.id).toBe('ws-1');
  });

  it('listWorkspaces 列出所有', () => {
    createWorkspace(ctx.db, { id: 'ws-1', name: 'A', folder: 'a' });
    createWorkspace(ctx.db, { id: 'ws-2', name: 'B', folder: 'b' });
    expect(listWorkspaces(ctx.db).length).toBe(2);
  });
});

describe('P2 · 桥接绑定', () => {
  let ctx: { db: DatabaseType; cleanup: () => void };

  beforeEach(() => {
    ctx = createTempDb();
    createWorkspace(ctx.db, { id: 'ws-1', name: '空间', folder: 'ws' });
    createAgentProfile(ctx.db, { id: 'prof-1', name: '助手' });
  });

  afterEach(() => {
    ctx.cleanup();
    resetDatabaseForTest();
  });

  it('绑定 Profile 到 Workspace', () => {
    const b = bindProfileToWorkspace(ctx.db, 'ws-1', 'prof-1', 'chat');
    expect(b.workspaceId).toBe('ws-1');
    expect(b.profileId).toBe('prof-1');
    expect(b.interactionMode).toBe('chat');
  });

  it('查询 Workspace 的绑定列表', () => {
    bindProfileToWorkspace(ctx.db, 'ws-1', 'prof-1');
    const list = getBindingsForWorkspace(ctx.db, 'ws-1');
    expect(list.length).toBe(1);
    expect(list[0].profileId).toBe('prof-1');
  });
});

describe('P2 · RuntimeSession 记录', () => {
  let ctx: { db: DatabaseType; cleanup: () => void };

  beforeEach(() => {
    ctx = createTempDb();
    createWorkspace(ctx.db, { id: 'ws-1', name: '空间', folder: 'ws' });
    createAgentProfile(ctx.db, { id: 'prof-1', name: '助手' });
  });

  afterEach(() => {
    ctx.cleanup();
    resetDatabaseForTest();
  });

  it('记录会话', () => {
    const s = recordRuntimeSession(ctx.db, {
      id: 'sess-1',
      workspaceId: 'ws-1',
      profileId: 'prof-1',
      sessionKey: 'channel:web:user-1',
    });
    expect(s.sessionKey).toBe('channel:web:user-1');
  });

  it('按 sessionKey 查询', () => {
    recordRuntimeSession(ctx.db, {
      id: 'sess-1', workspaceId: 'ws-1', profileId: 'prof-1',
      sessionKey: 'channel:web:user-1',
    });
    const s = getRuntimeSessionByKey(ctx.db, 'channel:web:user-1');
    expect(s).not.toBeNull();
    expect(s!.id).toBe('sess-1');
  });

  it('按 workspace 列出', () => {
    recordRuntimeSession(ctx.db, {
      id: 'sess-1', workspaceId: 'ws-1', profileId: 'prof-1',
      sessionKey: 'channel:web:user-1',
    });
    recordRuntimeSession(ctx.db, {
      id: 'sess-2', workspaceId: 'ws-1', profileId: 'prof-1',
      sessionKey: 'channel:web:user-2',
    });
    const list = listRuntimeSessions(ctx.db, 'ws-1');
    expect(list.length).toBe(2);
  });
});

describe('P2 · 多 Profile 隔离', () => {
  let ctx: { db: DatabaseType; cleanup: () => void };

  beforeEach(() => {
    ctx = createTempDb();
  });

  afterEach(() => {
    ctx.cleanup();
    resetDatabaseForTest();
  });

  it('hash 不串：不同 Profile 不同 hash', () => {
    const a = createAgentProfile(ctx.db, { id: 'prof-a', name: 'A', identityPrompt: '你' });
    const b = createAgentProfile(ctx.db, { id: 'prof-b', name: 'B', identityPrompt: '我' });
    expect(a.identityHash).not.toBe(b.identityHash);
  });

  it('分别更新互不影响', () => {
    createAgentProfile(ctx.db, { id: 'prof-a', name: 'A' });
    createAgentProfile(ctx.db, { id: 'prof-b', name: 'B' });
    updateAgentProfile(ctx.db, 'prof-a', { identityPrompt: 'changed' });
    const a = getAgentProfile(ctx.db, 'prof-a');
    const b = getAgentProfile(ctx.db, 'prof-b');
    expect(a!.version).toBe(2);
    expect(b!.version).toBe(1);
  });
});

describe('P2 · assertProductModelSchema', () => {
  let ctx: { db: DatabaseType; cleanup: () => void };

  beforeEach(() => {
    ctx = createTempDb();
  });

  afterEach(() => {
    ctx.cleanup();
    resetDatabaseForTest();
  });

  it('v2 迁移后结构断言通过', () => {
    expect(() => assertProductModelSchema(ctx.db)).not.toThrow();
  });
});

describe('P2 · 工具操作人审计', () => {
  let ctx: { db: DatabaseType; cleanup: () => void };

  beforeEach(() => {
    ctx = createTempDb();
  });

  afterEach(() => {
    ctx.cleanup();
    resetDatabaseForTest();
  });

  it('记录并查询 actorUserId', () => {
    recordToolCall(ctx.db, {
      agentId: 'agent-1',
      workspaceId: 'ws-1',
      sessionKey: 'channel:web#account:ws-1#conv:default',
      actorUserId: 'user-1',
      toolName: 'query_pen_metrics',
      input: { penId: 'A3' },
    });
    expect(listToolCalls(ctx.db, { workspaceId: 'ws-1' })[0].actorUserId).toBe('user-1');
  });
});
