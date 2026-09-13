/**
 * 多用户二期测试：凭据加密、工作区渠道设置 API、回合上下文（ALS）、迁移 v6。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { initDatabase, resetDatabaseForTest, setDatabaseForTest, CURRENT_SCHEMA_VERSION } from '../src/core/database.js';
import { createApp } from '../src/server.js';
import {
  createWorkspace,
  addWorkspaceMember,
  listWorkspaceMembers,
  getWorkspaceMembership,
} from '../src/core/models.js';
import {
  createUser,
  createWebSession,
  getSessionContext,
  resetRateLimits,
  setSessionWorkspace,
} from '../src/core/auth.js';
import { encryptJson, decryptJson, resetSecretKeyCache } from '../src/core/secret-box.js';
import { createMemoryTools } from '../src/memory/memory-tools.js';
import { turnContext } from '../src/core/runtime-context.js';
import { listRecallable } from '../src/memory/memory.js';

function createTempDb(): { db: DatabaseType; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniclaw-mu-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initDatabase(db);
  const cleanup = () => {
    db.close();
    for (const s of ['', '-wal', '-shm']) {
      try {
        fs.unlinkSync(dbPath + s);
      } catch {
        /* ignore */
      }
    }
    try {
      fs.rmdirSync(tmpDir);
    } catch {
      /* ignore */
    }
  };
  return { db, cleanup };
}

let userSeq = 0;

async function authedApp(db: DatabaseType) {
  const app = createApp({ db });
  const username = `mu${++userSeq}`;
  const reg = await app.fetch(
    new Request('http://localhost/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'password123' }),
    }),
  );
  const cookie = (reg.headers.get('Set-Cookie') ?? '').split(';')[0];
  const get = (p: string) => app.fetch(new Request('http://localhost' + p, { headers: { Cookie: cookie } }));
  const send = (p: string, method: string, body: unknown) =>
    app.fetch(
      new Request('http://localhost' + p, {
        method,
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  const me = (await (await get('/api/auth/me')).json()) as { workspaceId: string };
  return { app, get, send, me };
}

// ── 凭据保险箱 ────────────────────────────────────────────────────────

describe('secret-box（AES-256-GCM）', () => {
  it('加密→解密往返一致', () => {
    const payload = { botToken: 'secret-token-123', appId: 'x' };
    const sealed = encryptJson(payload);
    expect(sealed).not.toContain('secret-token-123');
    expect(decryptJson<typeof payload>(sealed)).toEqual(payload);
  });

  it('密文被篡改 → 解密失败（fail-closed）', () => {
    const sealed = encryptJson({ a: 1 });
    const [iv, tag, ct] = sealed.split('.');
    const tampered = `${iv}.${tag}.${ct.slice(0, -2)}ff`;
    expect(() => decryptJson(tampered)).toThrow(/解密失败/);
  });

  it('不同密钥无法解密', () => {
    const sealed = encryptJson({ a: 1 });
    process.env.CHANNEL_ENCRYPTION_KEY = 'another-key-value-1234567890';
    resetSecretKeyCache();
    try {
      expect(() => decryptJson(sealed)).toThrow();
    } finally {
      delete process.env.CHANNEL_ENCRYPTION_KEY;
      resetSecretKeyCache();
    }
  });
});

// ── 工作区渠道设置 API ────────────────────────────────────────────────

describe('渠道设置 API', () => {
  let db: DatabaseType;
  let cleanup: () => void;
  let auth: Awaited<ReturnType<typeof authedApp>>;

  beforeEach(async () => {
    ({ db, cleanup } = createTempDb());
    resetRateLimits();
    auth = await authedApp(db);
  });
  afterEach(() => {
    cleanup();
    resetDatabaseForTest();
  });

  it('保存凭据 → 库里是密文（不含明文），GET 只回配置状态不回凭据', async () => {
    const res = await auth.send('/api/channels/feishu', 'PUT', {
      credentials: { appId: 'cli-a', appSecret: 'SECRET-TOKEN' },
      enabled: true,
    });
    expect(res.status).toBe(200);

    const row = db.prepare('SELECT credentials FROM workspace_channels').get() as { credentials: string };
    expect(row.credentials).not.toContain('SUPER-SECRET-TOKEN');

    const list = (await (await auth.get('/api/channels')).json()) as Array<Record<string, unknown>>;
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual({ kind: 'feishu', accountId: '', enabled: true, configured: true });
    expect(JSON.stringify(list)).not.toContain('SUPER-SECRET-TOKEN');
  });

  it('启用但没给凭据 → 400；字段缺失 → 400', async () => {
    const noCreds = await auth.send('/api/channels/dingtalk', 'PUT', { enabled: true });
    expect(noCreds.status).toBe(400);
    const missing = await auth.send('/api/channels/feishu', 'PUT', {
      credentials: { appId: 'x' },
      enabled: true,
    });
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: string }).error).toContain('appSecret');
  });

  it('不支持的渠道 → 400；先存后只改开关仍保持已配置', async () => {
    expect((await auth.send('/api/channels/wechat', 'PUT', { enabled: true })).status).toBe(400);

    await auth.send('/api/channels/feishu', 'PUT', {
      credentials: { appId: 'cli-a', appSecret: 'S-1' },
      enabled: false,
    });
    const on = await auth.send('/api/channels/feishu', 'PUT', { enabled: true });
    expect(on.status).toBe(200);
    const list = (await (await auth.get('/api/channels')).json()) as Array<{ configured: boolean; enabled: boolean }>;
    expect(list[0]).toMatchObject({ configured: true, enabled: true });
  });

  it('删除配置', async () => {
    await auth.send('/api/channels/dingtalk', 'PUT', {
      credentials: { clientId: 'a', clientSecret: 'b' },
      enabled: true,
    });
    expect((await auth.send('/api/channels/dingtalk', 'DELETE', {})).status).toBe(200);
    const list = (await (await auth.get('/api/channels')).json()) as unknown[];
    expect(list).toHaveLength(0);
  });
});

// ── 回合上下文（ALS）：记忆工具按回合工作区取数 ──────────────────────

describe('回合上下文（ALS）', () => {
  let db: DatabaseType;
  let cleanup: () => void;

  beforeEach(() => {
    ({ db, cleanup } = createTempDb());
    resetRateLimits();
    // 记忆工具内部走 getDatabase() 单例 → 指到临时库，避免写入真实 data
    setDatabaseForTest(db);
  });
  afterEach(() => {
    cleanup();
    resetDatabaseForTest();
  });

  it('ALS 指定的工作区优先于工具默认值', async () => {
    const tools = createMemoryTools('ws-default');
    const remember = tools[1];
    await turnContext.run({ workspaceId: 'ws-real' }, () =>
      remember.execute('t1', { kind: 'fact', content: '按上下文落库' }),
    );
    expect(listRecallable(db, { workspaceId: 'ws-real' })).toHaveLength(1);
    expect(listRecallable(db, { workspaceId: 'ws-default' })).toHaveLength(0);
  });

  it('无上下文时回退默认工作区', async () => {
    const [recall] = createMemoryTools('ws-fallback');
    const res = await recall.execute('t1', { query: '任意词组' });
    expect(JSON.stringify(res)).toContain('没有相关记忆');
  });

  it('记忆工具默认写入当前会话，检索时不泄漏到其他会话', async () => {
    const tools = createMemoryTools('ws-default');
    const [recall, remember] = tools;
    await turnContext.run({ workspaceId: 'ws-real', sessionKey: 'channel:feishu#conv:ops' }, () =>
      remember.execute('t1', { kind: 'fact', content: '运营群临时约定：每天九点同步库存' }),
    );

    const hidden = await turnContext.run({ workspaceId: 'ws-real', sessionKey: 'channel:feishu#conv:sales' }, () =>
      recall.execute('t2', { query: '库存' }),
    );
    expect(JSON.stringify(hidden)).toContain('没有相关记忆');

    const visible = await turnContext.run({ workspaceId: 'ws-real', sessionKey: 'channel:feishu#conv:ops' }, () =>
      recall.execute('t3', { query: '库存' }),
    );
    expect(JSON.stringify(visible)).toContain('每天九点同步库存');
  });

  it('普通成员显式写团队记忆会被拦截', async () => {
    const [, remember] = createMemoryTools('ws-default');
    const result = await turnContext.run(
      { workspaceId: 'ws-real', sessionKey: 'channel:web#conv:member', workspaceRole: 'member' },
      () => remember.execute('t4', { kind: 'fact', content: '不应直接写团队记忆', scope: 'workspace' }),
    );
    expect(JSON.stringify(result)).toContain('团队共享记忆需管理员确认');
    expect(listRecallable(db, { workspaceId: 'ws-real' })).toHaveLength(0);
  });
});

// ── 迁移 v6 ───────────────────────────────────────────────────────────

describe('迁移 v6', () => {
  let db: DatabaseType;
  let cleanup: () => void;

  beforeEach(() => {
    ({ db, cleanup } = createTempDb());
  });
  afterEach(() => {
    cleanup();
    resetDatabaseForTest();
  });

  it('新库版本头为 v6，workspace_channels 可写入', () => {
    const ver = db.prepare("SELECT value FROM router_state WHERE key='schema_version'").get() as { value: string };
    expect(Number(ver.value)).toBe(CURRENT_SCHEMA_VERSION);
    createWorkspace(db, { id: 'ws-1', name: '空间', folder: 'ws1' });
    db.prepare(
      "INSERT INTO workspace_channels (id, workspace_id, kind, credentials, enabled) VALUES ('wc-1','ws-1','feishu','iv.tag.ct',1)",
    ).run();
    const n = (db.prepare('SELECT COUNT(*) AS c FROM workspace_channels').get() as { c: number }).c;
    expect(n).toBe(1);
  });
});

describe('共享 Workspace 成员模型', () => {
  let db: DatabaseType;
  let cleanup: () => void;

  beforeEach(() => {
    ({ db, cleanup } = createTempDb());
  });

  afterEach(() => {
    cleanup();
    resetDatabaseForTest();
  });

  it('同一个 Workspace 可以添加多个成员并读取角色', () => {
    const owner = createUser(db, { username: 'owner1', password: 'password123' });
    const member = createUser(db, { username: 'member1', password: 'password123' });
    createWorkspace(db, { id: 'team-1', name: '团队', folder: 'team-1', owner: owner.id });

    addWorkspaceMember(db, { workspaceId: 'team-1', userId: owner.id, role: 'owner' });
    addWorkspaceMember(db, { workspaceId: 'team-1', userId: member.id, role: 'member' });

    expect(listWorkspaceMembers(db, 'team-1')).toHaveLength(2);
    expect(getWorkspaceMembership(db, 'team-1', member.id)).toMatchObject({
      workspaceId: 'team-1',
      userId: member.id,
      role: 'member',
    });
  });

  it('同一用户重复加入同一 Workspace 被拒绝', () => {
    const owner = createUser(db, { username: 'owner2', password: 'password123' });
    createWorkspace(db, { id: 'team-2', name: '团队', folder: 'team-2', owner: owner.id });
    addWorkspaceMember(db, { workspaceId: 'team-2', userId: owner.id, role: 'owner' });

    expect(() => addWorkspaceMember(db, { workspaceId: 'team-2', userId: owner.id, role: 'member' })).toThrow();
  });
});

describe('活动 Workspace 会话', () => {
  let db: DatabaseType;
  let cleanup: () => void;

  beforeEach(() => {
    ({ db, cleanup } = createTempDb());
  });

  afterEach(() => {
    cleanup();
    resetDatabaseForTest();
  });

  it('Web Session 记录并返回成员当前 Workspace', () => {
    const user = createUser(db, { username: 'switcher', password: 'password123' });
    createWorkspace(db, { id: 'team-session', name: '团队', folder: 'team-session' });
    addWorkspaceMember(db, { workspaceId: 'team-session', userId: user.id, role: 'member' });
    const session = createWebSession(db, user.id, 'team-session');
    expect(getSessionContext(db, session.token)).toMatchObject({
      user: { id: user.id },
      workspaceId: 'team-session',
    });
  });

  it('只能切换到自己所属的 Workspace', () => {
    const user = createUser(db, { username: 'switcher2', password: 'password123' });
    createWorkspace(db, { id: 'team-owned', name: '所属团队', folder: 'team-owned' });
    createWorkspace(db, { id: 'team-other', name: '其他团队', folder: 'team-other' });
    addWorkspaceMember(db, { workspaceId: 'team-owned', userId: user.id, role: 'member' });
    const session = createWebSession(db, user.id, 'team-owned');

    expect(setSessionWorkspace(db, session.token, 'team-other')).toBe(false);
    expect(getSessionContext(db, session.token)?.workspaceId).toBe('team-owned');
  });
});
