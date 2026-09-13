/**
 * 服务端点测试：认证、多用户隔离、身份、记忆、会话键、历史与确认。
 * 每个用例组都走真实的 注册→Set-Cookie→带 Cookie 请求 链路。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { initDatabase, resetDatabaseForTest } from '../src/core/database.js';
import { createApp } from '../src/server.js';
import { appendChatMessage, createAgentProfile, addWorkspaceMember } from '../src/core/models.js';
import { createUser, createWebSession, issueCookieValue, resetRateLimits, SESSION_COOKIE } from '../src/core/auth.js';
import { permissionLoop } from '../src/permissions/permission-loop.js';

function createTempDb(): { db: DatabaseType; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniclaw-server-test-'));
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

/** 注册并登录一个用户，返回带 Cookie 的请求助手 */
async function authedApp(db: DatabaseType) {
  const app = createApp({ db });
  const username = `tester${++userSeq}`;
  const reg = await app.fetch(
    new Request('http://localhost/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'password123' }),
    }),
  );
  if (reg.status !== 200) throw new Error(`注册失败: ${reg.status}`);
  const cookie = (reg.headers.get('Set-Cookie') ?? '').split(';')[0];
  const call = (p: string, init: RequestInit = {}) =>
    app.fetch(new Request('http://localhost' + p, { ...init, headers: { Cookie: cookie, ...(init.headers ?? {}) } }));
  const get = (p: string) => call(p);
  const send = (p: string, method: string, body: unknown) =>
    call(p, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const me = (await (await get('/api/auth/me')).json()) as { workspaceId: string; profileId: string };
  return { app, call, get, send, me, username, cookie };
}

describe('认证', () => {
  let db: DatabaseType;
  let cleanup: () => void;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    ({ db, cleanup } = createTempDb());
    app = createApp({ db });
    resetRateLimits();
  });
  afterEach(() => {
    cleanup();
    resetDatabaseForTest();
  });

  const post = (p: string, body: unknown) =>
    app.fetch(
      new Request('http://localhost' + p, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );

  it('未登录访问业务 API → 401', async () => {
    expect((await app.fetch(new Request('http://localhost/api/persona'))).status).toBe(401);
    expect((await app.fetch(new Request('http://localhost/api/memory'))).status).toBe(401);
  });

  it('注册 → me 返回用户与工作区；重复用户名 409', async () => {
    const res = await post('/api/auth/register', { username: 'alice', password: 'password123' });
    expect(res.status).toBe(200);
    const cookie = (res.headers.get('Set-Cookie') ?? '').split(';')[0];
    const me = await (
      await app.fetch(new Request('http://localhost/api/auth/me', { headers: { Cookie: cookie } }))
    ).json();
    expect((me as { user: { username: string } }).user.username).toBe('alice');
    expect((me as { workspaceId: string }).workspaceId).toBeTruthy();

    const dup = await post('/api/auth/register', { username: 'alice', password: 'password456' });
    expect(dup.status).toBe(409);
  });

  it('注册校验：用户名/密码不合法 400', async () => {
    expect((await post('/api/auth/register', { username: 'a', password: 'password123' })).status).toBe(400);
    expect((await post('/api/auth/register', { username: 'okname', password: 'short' })).status).toBe(400);
  });

  it('登录：正确密码 200；错误密码/不存在用户都 401（不可枚举）', async () => {
    await post('/api/auth/register', { username: 'bob', password: 'password123' });
    const ok = await post('/api/auth/login', { username: 'bob', password: 'password123' });
    expect(ok.status).toBe(200);
    expect((await post('/api/auth/login', { username: 'bob', password: 'wrong-password' })).status).toBe(401);
    expect((await post('/api/auth/login', { username: 'ghost', password: 'whatever-long' })).status).toBe(401);
  });

  it('伪造 HMAC 的 cookie → 401', async () => {
    await post('/api/auth/register', { username: 'carol', password: 'password123' });
    const forged = 'deadbeef.deadbeef';
    const res = await app.fetch(
      new Request('http://localhost/api/persona', { headers: { Cookie: `miniclaw_session=${forged}` } }),
    );
    expect(res.status).toBe(401);
  });

  it('logout 后会话失效', async () => {
    const reg = await post('/api/auth/register', { username: 'dave', password: 'password123' });
    const cookie = (reg.headers.get('Set-Cookie') ?? '').split(';')[0];
    await app.fetch(new Request('http://localhost/api/auth/logout', { method: 'POST', headers: { Cookie: cookie } }));
    const res = await app.fetch(new Request('http://localhost/api/persona', { headers: { Cookie: cookie } }));
    expect(res.status).toBe(401);
  });

  it('ALLOW_REGISTER=0 时第二个用户注册被拒', async () => {
    process.env.ALLOW_REGISTER = '0';
    try {
      await post('/api/auth/register', { username: 'first', password: 'password123' });
      const second = await post('/api/auth/register', { username: 'second', password: 'password123' });
      expect(second.status).toBe(403);
    } finally {
      delete process.env.ALLOW_REGISTER;
    }
  });

  it('多用户隔离：A 的记忆/身份修改，B 看不到', async () => {
    const a = await authedApp(db);
    const b = await authedApp(db);
    // A 写记忆
    const created = await (await a.send('/api/memory', 'POST', { kind: 'fact', content: 'A 的私密知识' })).json();
    // B 的记忆列表不含 A 的条目
    const bList = await (await b.get('/api/memory')).json();
    expect(bList.some((m: { id: string }) => m.id === (created as { item: { id: string } }).item.id)).toBe(false);
    // B 改自己身份不影响 A
    await b.send('/api/persona', 'PUT', { identityPrompt: 'B 的身份。' });
    const aPersona = await (await a.get('/api/persona')).json();
    const bPersona = await (await b.get('/api/persona')).json();
    expect(aPersona.segments.identity).not.toBe(bPersona.segments.identity);
    expect(aPersona.id).not.toBe(bPersona.id);
    // 对话历史互不可见
    const aKey = `channel:web#account:${a.me.workspaceId}#conv:default`;
    appendChatMessage(db, { sessionKey: aKey, role: 'user', content: 'A 的对话' });
    const bHistory = await (await b.get('/api/chat/history')).json();
    expect(bHistory.some((h: { content: string }) => h.content === 'A 的对话')).toBe(false);
    const aHistory = await (await a.get('/api/chat/history')).json();
    expect(aHistory.some((h: { content: string }) => h.content === 'A 的对话')).toBe(true);

    const crossWorkspaceUpdate = await b.send(
      `/api/memory/${(created as { item: { id: string } }).item.id}`,
      'PUT',
      { expectedRevision: 1, content: 'B 不应覆盖 A 的记忆' },
    );
    expect(crossWorkspaceUpdate.status).toBe(404);
  });
});

describe('共享 Workspace API', () => {
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

  it('Workspace 成员可以访问共享空间并列出成员', async () => {
    const member = createUser(db, { username: `member${Date.now()}`, password: 'password123' });
    addWorkspaceMember(db, { workspaceId: auth.me.workspaceId, userId: member.id, role: 'member' });
    const session = createWebSession(db, member.id, auth.me.workspaceId);
    const cookie = `${SESSION_COOKIE}=${encodeURIComponent(issueCookieValue(session.token))}`;

    const meRes = await auth.app.fetch(new Request('http://localhost/api/auth/me', { headers: { Cookie: cookie } }));
    expect(meRes.status).toBe(200);
    expect(await meRes.json()).toMatchObject({ workspaceId: auth.me.workspaceId, role: 'member' });

    const listRes = await auth.get('/api/workspace/members');
    expect(listRes.status).toBe(200);
    expect(JSON.stringify(await listRes.json())).toContain(member.username);
  });

  it('管理员可以添加成员，普通成员不能添加成员', async () => {
    const newUser = createUser(db, { username: `newmember${Date.now()}`, password: 'password123' });
    const addRes = await auth.send('/api/workspace/members', 'POST', { username: newUser.username, role: 'member' });
    expect(addRes.status).toBe(201);

    const member = createUser(db, { username: `plain${Date.now()}`, password: 'password123' });
    addWorkspaceMember(db, { workspaceId: auth.me.workspaceId, userId: member.id, role: 'member' });
    const session = createWebSession(db, member.id, auth.me.workspaceId);
    const cookie = `${SESSION_COOKIE}=${encodeURIComponent(issueCookieValue(session.token))}`;
    const res = await auth.app.fetch(new Request('http://localhost/api/workspace/members', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: newUser.username, role: 'member' }),
    }));
    expect(res.status).toBe(403);
  });

  it('管理员可以调整普通成员角色并移除成员，不能移除 Workspace owner', async () => {
    const member = createUser(db, { username: `rolechange${Date.now()}`, password: 'password123' });
    addWorkspaceMember(db, { workspaceId: auth.me.workspaceId, userId: member.id, role: 'member' });
    const promote = await auth.send(`/api/workspace/members/${member.id}`, 'PATCH', { role: 'admin' });
    expect(promote.status).toBe(200);
    expect((await promote.json() as { role: string }).role).toBe('admin');

    const remove = await auth.call(`/api/workspace/members/${member.id}`, { method: 'DELETE' });
    expect(remove.status).toBe(200);
    const owner = (await (await auth.get('/api/workspace/members')).json() as Array<{ userId: string; role: string }>)
      .find((m) => m.role === 'owner');
    expect(owner).toBeTruthy();
    const ownerRemove = await auth.call(`/api/workspace/members/${owner?.userId ?? ownerId}`, { method: 'DELETE' });
    expect(ownerRemove.status).toBe(400);
  });

  it('普通成员可以贡献团队记忆，但不能修改工作区配置或覆盖既有记忆', async () => {
    const member = createUser(db, { username: `contributor${Date.now()}`, password: 'password123' });
    addWorkspaceMember(db, { workspaceId: auth.me.workspaceId, userId: member.id, role: 'member' });
    const session = createWebSession(db, member.id, auth.me.workspaceId);
    const cookie = `${SESSION_COOKIE}=${encodeURIComponent(issueCookieValue(session.token))}`;
    const call = (p: string, init: RequestInit = {}) => auth.app.fetch(new Request('http://localhost' + p, {
      ...init,
      headers: { Cookie: cookie, ...(init.headers ?? {}) },
    }));
    const send = (p: string, method: string, body: unknown) => call(p, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const contributed = await send('/api/memory', 'POST', { kind: 'fact', content: '成员贡献的团队事实' });
    expect(contributed.status).toBe(201);
    const itemId = ((await contributed.json()) as { item: { id: string } }).item.id;

    expect((await send('/api/persona', 'PUT', { identityPrompt: '成员不应覆盖身份' })).status).toBe(403);
    expect((await send('/api/channels/feishu', 'PUT', { enabled: false })).status).toBe(403);
    expect((await send('/api/tasks', 'POST', { name: '成员任务', prompt: '不应创建', schedule: { type: 'once', at: new Date(Date.now() + 60_000).toISOString() } })).status).toBe(403);
    expect((await send(`/api/memory/${itemId}`, 'PUT', { expectedRevision: 1, content: '不应覆盖' })).status).toBe(403);
    expect((await send(`/api/memory/${itemId}`, 'DELETE', { expectedRevision: 1 })).status).toBe(403);
  });

  it('工作区可以登记多个角色 Agent，普通成员不能改 Agent 注册表', async () => {
    const before = await (await auth.get('/api/agents')).json() as Array<{ id: string }>;
    expect(before.length).toBe(1);
    const created = await auth.send('/api/agents', 'POST', {
      name: '客服 Agent',
      identityPrompt: '你负责团队客服工作。',
      interactionMode: 'chat',
    });
    expect(created.status).toBe(201);
    const agents = await (await auth.get('/api/agents')).json() as Array<{ name: string }>;
    expect(agents.map((a) => a.name)).toEqual(expect.arrayContaining(['客服 Agent']));

    const member = createUser(db, { username: `agentmember${Date.now()}`, password: 'password123' });
    addWorkspaceMember(db, { workspaceId: auth.me.workspaceId, userId: member.id, role: 'member' });
    const session = createWebSession(db, member.id, auth.me.workspaceId);
    const cookie = `${SESSION_COOKIE}=${encodeURIComponent(issueCookieValue(session.token))}`;
    const res = await auth.app.fetch(new Request('http://localhost/api/agents', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '成员不应创建' }),
    }));
    expect(res.status).toBe(403);
  });
});

describe('身份管理端点', () => {
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

  it('GET /api/persona：默认身份 version=1，指纹为 64 位 hex', async () => {
    const res = await auth.get('/api/persona');
    expect(res.status).toBe(200);
    const p = await res.json();
    expect(p.version).toBe(1);
    expect(p.segments.identity).toContain('养殖场健康管理数字员工');
    expect(p.identityHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('PUT：更新身份 → version+1、指纹变化', async () => {
    const before = await (await auth.get('/api/persona')).json();
    const res = await auth.send('/api/persona', 'PUT', {
      name: '毒舌猪场管理员',
      identityPrompt: '你是毒舌但靠谱的猪场健康管理员。',
      soulPrompt: '短句，爱用反问，从不道歉。',
    });
    expect(res.status).toBe(200);
    const after = await res.json();
    expect(after.version).toBe(2);
    expect(after.name).toBe('毒舌猪场管理员');
    expect(after.identityHash).not.toBe(before.identityHash);
    // 未提供的段保持原值（partial 合并）
    expect(after.segments.agents).toBe(before.segments.agents);
  });

  it('PUT：必填段为空 → 400 且不落库', async () => {
    const res = await auth.send('/api/persona', 'PUT', { identityPrompt: '   ' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('IDENTITY');
    const p = await (await auth.get('/api/persona')).json();
    expect(p.version).toBe(1);
  });

  it('PUT：段超 20K → 400', async () => {
    const res = await auth.send('/api/persona', 'PUT', { agentsPrompt: 'a'.repeat(20_001) });
    expect(res.status).toBe(400);
  });

  it('PUT：同内容重放 → 幂等，版本不动', async () => {
    const before = await (await auth.get('/api/persona')).json();
    const res = await auth.send('/api/persona', 'PUT', {
      name: before.name,
      identityPrompt: before.segments.identity,
      soulPrompt: before.segments.soul,
      agentsPrompt: before.segments.agents,
      toolsPrompt: before.segments.tools,
    });
    const after = await res.json();
    expect(after.version).toBe(before.version);
    expect(after.identityHash).toBe(before.identityHash);
  });

  it('GET /api/persona/versions：两次编辑后 v3/v2/v1 降序，快照保留历史值', async () => {
    await auth.send('/api/persona', 'PUT', { identityPrompt: '你是 A。' });
    await auth.send('/api/persona', 'PUT', { identityPrompt: '你是 B。' });
    const rows = await (await auth.get('/api/persona/versions')).json();
    expect(rows.map((r: { version: number }) => r.version)).toEqual([3, 2, 1]);
    expect(rows[0].snapshot.identityPrompt).toBe('你是 B。');
    expect(rows[1].snapshot.identityPrompt).toBe('你是 A。');
    expect(rows[2].snapshot.identityPrompt).toContain('养殖场健康管理数字员工');
  });
});

describe('记忆管理端点', () => {
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

  it('POST 创建 → 201，GET 列表可见', async () => {
    const res = await auth.send('/api/memory', 'POST', { kind: 'fact', content: '复检任务需负责人确认', importance: 0.8 });
    expect(res.status).toBe(201);
    const { item } = await res.json();
    expect(item.kind).toBe('fact');
    expect(item.revision).toBe(1);
    const list = await (await auth.get('/api/memory')).json();
    expect(list.some((m: { id: string }) => m.id === item.id)).toBe(true);
  });

  it('POST 非法 kind → 400', async () => {
    const res = await auth.send('/api/memory', 'POST', { kind: 'nonsense', content: 'x' });
    expect(res.status).toBe(400);
  });

  it('PUT 正确 revision → r+1；过期 revision → 409 回传 currentRevision', async () => {
    const created = await (await auth.send('/api/memory', 'POST', { kind: 'lesson', content: '初版' })).json();
    const id = created.item.id;
    const ok = await auth.send(`/api/memory/${id}`, 'PUT', { expectedRevision: 1, content: '改过的内容' });
    expect(ok.status).toBe(200);
    expect((await ok.json()).revision).toBe(2);
    // 用旧的 r1 再提交 → CAS 冲突
    const conflict = await auth.send(`/api/memory/${id}`, 'PUT', { expectedRevision: 1, content: '并发覆盖' });
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).currentRevision).toBe(2);
  });

  it('DELETE 忘记 → 列表消失，修订史保留 forget', async () => {
    const created = await (await auth.send('/api/memory', 'POST', { kind: 'decision', content: '待撤销' })).json();
    const id = created.item.id;
    const res = await auth.send(`/api/memory/${id}`, 'DELETE', { expectedRevision: 1, reason: '测试遗忘' });
    expect(res.status).toBe(200);
    const list = await (await auth.get('/api/memory')).json();
    expect(list.some((m: { id: string }) => m.id === id)).toBe(false);
    const versions = await (await auth.get(`/api/memory/${id}/versions`)).json();
    expect(versions.some((v: { changeType: string }) => v.changeType === 'forget')).toBe(true);
  });

  it('幂等重放：同键同内容 replayed=true，同键异内容 409', async () => {
    const body = { kind: 'fact', content: '幂等测试', idempotencyKey: 'k-1' };
    const first = await (await auth.send('/api/memory', 'POST', body)).json();
    expect(first.replayed).toBe(false);
    const replay = await (await auth.send('/api/memory', 'POST', body)).json();
    expect(replay.replayed).toBe(true);
    expect(replay.item.id).toBe(first.item.id);
    const clash = await auth.send('/api/memory', 'POST', { kind: 'fact', content: '不同内容', idempotencyKey: 'k-1' });
    expect(clash.status).toBe(409);
  });

  it('检索：≥3 字命中，短中文词降级 LIKE 命中', async () => {
    await auth.send('/api/memory', 'POST', { kind: 'fact', title: '指标同步', content: '每小时从主数据同步一次生产指标表' });
    const long = await (await auth.get('/api/memory?q=' + encodeURIComponent('指标表'))).json();
    expect(long.length).toBeGreaterThanOrEqual(1);
    const short = await (await auth.get('/api/memory?q=' + encodeURIComponent('同步'))).json();
    expect(short.length).toBeGreaterThanOrEqual(1);
  });
});

describe('复合会话键端点', () => {
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

  it('build 返回 canonical 键 + parse 还原一致', async () => {
    const res = await auth.get('/api/session-key?kind=feishu&account=bot-a&conv=oc_1&thread=t9');
    expect(res.status).toBe(200);
    const { key, parts } = await res.json();
    expect(key).toBe('channel:feishu#account:bot-a#conv:oc_1#thread:t9');
    expect(parts).toEqual({ kind: 'feishu', conversationId: 'oc_1', accountId: 'bot-a', threadId: 't9' });
  });

  it('无 account/thread → 退化旧格式', async () => {
    const { key } = await (await auth.get('/api/session-key?kind=web&conv=user1')).json();
    expect(key).toBe('channel:web:user1');
  });

  it('空 kind → 400', async () => {
    const res = await auth.get('/api/session-key?kind=&conv=x');
    expect(res.status).toBe(400);
  });

  it('parse 端点还原复合格式', async () => {
    const res = await auth.get('/api/session-key/parse?key=' + encodeURIComponent('channel:feishu#account:ops#conv:-100#thread:7'));
    const { parts } = await res.json();
    expect(parts).toEqual({ kind: 'feishu', conversationId: '-100', accountId: 'ops', threadId: '7' });
  });
});

describe('对话历史与确认端点', () => {
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

  it('GET /api/chat/history：空返回 []，落库后按时间正序返回', async () => {
    const empty = await (await auth.get('/api/chat/history')).json();
    expect(empty).toEqual([]);
    const key = `channel:web#account:${auth.me.workspaceId}#conv:default`;
    appendChatMessage(db, { sessionKey: key, role: 'user', content: '第一句' });
    appendChatMessage(db, { sessionKey: key, role: 'assistant', content: '第一答' });
    const rows = await (await auth.get('/api/chat/history')).json();
    expect(rows.map((r: { role: string; content: string }) => `${r.role}:${r.content}`)).toEqual([
      'user:第一句',
      'assistant:第一答',
    ]);
  });

  it('POST /api/permission/confirm：参数缺失 400；未知 id 404', async () => {
    expect((await auth.send('/api/permission/confirm', 'POST', { id: 'x' })).status).toBe(400);
    const res = await auth.send('/api/permission/confirm', 'POST', { id: 'nonexistent', approve: true });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error?: string }).error).toContain('不存在或已过期');
  });
});

describe('对抗性回归（多用户越权与升级场景）', () => {
  let db: DatabaseType;
  let cleanup: () => void;

  beforeEach(() => {
    ({ db, cleanup } = createTempDb());
    resetRateLimits();
  });
  afterEach(() => {
    cleanup();
    resetDatabaseForTest();
  });

  it('BUG-1 回归：B 不能确认 A 工作区的待确认请求（404 反枚举，且不破坏 A 的裁决权）', async () => {
    const a = await authedApp(db);
    const b = await authedApp(db);
    // A 的工作区发起一条待确认请求（模拟工具触发的确认卡）
    const aKey = `channel:web#account:${a.me.workspaceId}#conv:default`;
    const action = permissionLoop.request({
      tool: 'create_inspection_task',
      args: { penId: 'A3', reason: '采食量下降且出现咳嗽' },
      summary: '为 A3 创建复检任务：采食量下降且出现咳嗽',
      sessionKey: aKey,
    });
    // B 尝试确认 → 404，且待办仍在（A 不受影响）
    const stolen = await b.send(`/api/permission/confirm`, 'POST', { id: action.id, approve: true });
    expect(stolen.status).toBe(404);
    expect(permissionLoop.pendingIds()).toContain(action.id);
    // A 正常裁决 → 执行
    const ok = await a.send(`/api/permission/confirm`, 'POST', { id: action.id, approve: true });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { resultText: string }).resultText).toContain('复检任务');
  });

  it('BUG-2 回归：升级场景下遗留 web-default 只归第一个工作区，第二用户拿专属身份', async () => {
    // 模拟老库升级状态：全局 web-default 已存在
    createAgentProfile(db, {
      id: 'web-default',
      name: '旧助手',
      identityPrompt: '你是旧版助手。',
      agentsPrompt: '旧规则。',
    });
    const a = await authedApp(db); // 首个用户接管/建工作区 → 绑定 web-default
    const b = await authedApp(db); // 第二个用户 → 必须拿专属 profile
    expect(a.me.profileId).toBe('web-default');
    expect(b.me.profileId).not.toBe('web-default');
    // B 改身份不影响 A
    await b.send('/api/persona', 'PUT', { identityPrompt: 'B 专属身份。' });
    const aPersona = await (await a.get('/api/persona')).json();
    expect(aPersona.segments.identity).toBe('你是旧版助手。');
  });
});
