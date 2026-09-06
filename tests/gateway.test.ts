/**
 * 网关层测试：SessionRouter 隔离与串行、入站门控与回发、记忆工具、确认回路。
 * 全部用假会话工厂/假渠道，不依赖真实凭据与 LLM。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { SessionRouter } from '../src/session-router.js';
import { startGateway, type GatewayChannel, type GatewayMessage } from '../src/gateway.js';
import { initDatabase, resetDatabaseForTest, CURRENT_SCHEMA_VERSION } from '../src/database.js';
import { appendChatMessage, listChatMessages } from '../src/models.js';
import { createMemoryTools } from '../src/memory-tools.js';
import { permissionLoop } from '../src/permission-loop.js';
import { turnContext } from '../src/runtime-context.js';
import type { AgentSessionHandle } from '../src/agent-runtime.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时');
    await sleep(10);
  }
}

// ── 假会话工厂：记录创建名；session.prompt 回显并发出 agent_end ────────

function fakeFactory(log: string[]) {
  return async (sessionName: string): Promise<AgentSessionHandle> => {
    log.push(`create:${sessionName}`);
    const subscribers: Array<(e: any) => void> = [];
    const session = {
      subscribe(l: (e: any) => void) {
        subscribers.push(l);
        return () => {
          const i = subscribers.indexOf(l);
          if (i >= 0) subscribers.splice(i, 1);
        };
      },
      async prompt(t: string) {
        await sleep(5);
        for (const l of [...subscribers]) {
          l({
            type: 'agent_end',
            sessionId: sessionName,
            messages: [{ role: 'assistant', content: [{ type: 'text', text: `echo:${t}` }] }],
          });
        }
      },
      waitForIdle: async () => {},
      dispose: undefined as unknown as () => void,
    };
    let disposed = false;
    return {
      session,
      sessionName,
      dispose: () => {
        disposed = true;
        log.push(`dispose:${sessionName}`);
      },
    };
  };
}

// ── SessionRouter ─────────────────────────────────────────────────────

describe('SessionRouter', () => {
  it('sessionNameFor：非法字符折叠为下划线并加前缀', () => {
    const name = SessionRouter.sessionNameFor('channel:feishu#account:bot a#conv:oc 1');
    expect(name).toMatch(/^ch-[a-zA-Z0-9._-]+$/);
    expect(name).not.toContain(':');
    expect(name).not.toContain('#');
  });

  it('同键复用同一会话，异键各建各的', async () => {
    const log: string[] = [];
    const router = new SessionRouter(fakeFactory(log));
    const a1 = await router.get('channel:web:u1');
    const a2 = await router.get('channel:web:u1');
    const b = await router.get('channel:feishu:oc1');
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
    expect(log.filter((l) => l.startsWith('create'))).toHaveLength(2);
    await router.clear();
  });

  it('同键串行执行：并发三个也只有一个在跑', async () => {
    const router = new SessionRouter(fakeFactory([]));
    let active = 0;
    let maxActive = 0;
    const task = () =>
      router.run('k', async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await sleep(20);
        active--;
      });
    await Promise.all([task(), task(), task()]);
    expect(maxActive).toBe(1);
    await router.clear();
  });

  it('不同键之间并行，不互相阻塞', async () => {
    const router = new SessionRouter(fakeFactory([]));
    let active = 0;
    let maxActive = 0;
    const task = (k: string) =>
      router.run(k, async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await sleep(20);
        active--;
      });
    await Promise.all([task('a'), task('b'), task('c')]);
    expect(maxActive).toBe(3);
    await router.clear();
  });

  it('clear() 释放全部会话；一轮失败不阻塞后续', async () => {
    const log: string[] = [];
    const router = new SessionRouter(fakeFactory(log));
    await router.get('k1');
    await router.get('k2');
    await router.clear();
    expect(log.filter((l) => l.startsWith('dispose'))).toHaveLength(2);
    expect(router.size()).toBe(0);

    const boom = new SessionRouter(fakeFactory([]));
    await expect(boom.run('k', async () => { throw new Error('x'); })).rejects.toThrow('x');
    const ok = await boom.run('k', async () => 'survived');
    expect(ok).toBe('survived');
    await boom.clear();
  });
});

// ── Gateway：门控、回发、历史落库 ─────────────────────────────────────

function fakeChannel(): GatewayChannel & { sent: Array<{ to: string; text: string }>; readonly connectCalls: number; readonly disconnectCalls: number; emit(m: GatewayMessage): void } {
  const sent: Array<{ to: string; text: string }> = [];
  let connectCalls = 0;
  let disconnectCalls = 0;
  let fn: ((m: GatewayMessage) => void) | null = null;
  return {
    sent,
    get connectCalls() {
      return connectCalls;
    },
    get disconnectCalls() {
      return disconnectCalls;
    },
    channel: {
      kind: 'test',
      capabilities: { streaming: false },
      async connect() {
        connectCalls++;
      },
      async disconnect() {
        disconnectCalls++;
      },
      isConnected: () => true,
      async sendMessage(to: string, text: string) {
        sent.push({ to, text });
      },
    } as GatewayChannel['channel'],
    bind(cb: (m: GatewayMessage) => void) {
      fn = cb;
    },
    emit(m: GatewayMessage) {
      fn?.(m);
    },
  };
}

describe('Gateway', () => {
  let db: DatabaseType;
  let cleanup: () => void;

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniclaw-gw-test-'));
    const dbPath = path.join(tmpDir, 't.db');
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    initDatabase(db);
    cleanup = () => {
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
      resetDatabaseForTest();
    };
  });

  afterEach(() => cleanup());

  function makeGateway(ch: ReturnType<typeof fakeChannel>, opts?: { requireMention?: boolean }) {
    return startGateway({
      channels: [ch],
      router: new SessionRouter(fakeFactory([])),
      requireMention: opts?.requireMention ?? true,
      appendMessage: (key, role, content, meta) => appendChatMessage(db, { sessionKey: key, role, content, meta }),
    });
  }

  it('单聊消息 → 按键路由、回发原对话、历史落库', async () => {
    const ch = fakeChannel();
    const gw = await makeGateway(ch);
    ch.emit({ kind: 'test', conversationId: 'u1', text: '你好', chatType: 'p2p', mentioned: false });
    await waitFor(() => ch.sent.length === 1);
    expect(ch.sent[0]).toEqual({ to: 'u1', text: 'echo:你好' });
    const rows = listChatMessages(db, { sessionKey: 'channel:test:u1' });
    expect(rows.map((r) => r.role)).toEqual(['user', 'assistant']);
    expect(rows[1].content).toBe('echo:你好');
    await gw.stop();
  });

  it('群聊未 @ → 忽略；@ 了 → 处理', async () => {
    const ch = fakeChannel();
    const gw = await makeGateway(ch);
    ch.emit({ kind: 'test', conversationId: 'g1', text: '闲聊', chatType: 'group', mentioned: false });
    await sleep(80);
    expect(ch.sent).toHaveLength(0);
    ch.emit({ kind: 'test', conversationId: 'g1', text: '@bot 查库存', chatType: 'group', mentioned: true });
    await waitFor(() => ch.sent.length === 1);
    expect(ch.sent[0].text).toBe('echo:@bot 查库存');
    await gw.stop();
  });

  it('requireMention=false 时群聊无需 @ 也处理', async () => {
    const ch = fakeChannel();
    const gw = await makeGateway(ch, { requireMention: false });
    ch.emit({ kind: 'test', conversationId: 'g2', text: '直接说话', chatType: 'group' });
    await waitFor(() => ch.sent.length === 1);
    await gw.stop();
  });

  it('未连接的渠道在启动时被 connect；stop 时 disconnect', async () => {
    const ch = fakeChannel();
    (ch.channel as { isConnected(): boolean }).isConnected = () => false;
    const gw = await makeGateway(ch);
    await waitFor(() => ch.connectCalls === 1);
    await gw.stop();
    expect(ch.disconnectCalls).toBe(1);
  });

  it('回合抛错 → 记录 system 消息，不炸网关', async () => {
    const ch = fakeChannel();
    const router = new SessionRouter(fakeFactory([]));
    const gw = await startGateway({
      channels: [ch],
      router,
      appendMessage: (key, role, content) => {
        if (role === 'assistant') throw new Error('模拟落库失败');
        appendChatMessage(db, { sessionKey: key, role, content });
      },
    });
    ch.emit({ kind: 'test', conversationId: 'u2', text: 'hi', chatType: 'p2p' });
    await waitFor(() => listChatMessages(db, { sessionKey: 'channel:test:u2' }).some((r) => r.role === 'system'));
    await gw.stop();
  });
});

// ── 记忆工具 ──────────────────────────────────────────────────────────

describe('记忆工具（recall/remember）', () => {
  let db: DatabaseType;
  let cleanup: () => void;

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniclaw-mtool-test-'));
    const dbPath = path.join(tmpDir, 't.db');
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    initDatabase(db);
    cleanup = () => {
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
      resetDatabaseForTest();
    };
  });

  afterEach(() => cleanup());

  it('remember 写入 → recall 检索命中；无命中给空提示', async () => {
    const [recall, remember] = createMemoryTools('ws-tools');
    const put = await remember.execute('t1', { kind: 'fact', content: '改价前必须先确认', title: '改价规则', importance: 0.9 });
    expect(JSON.stringify(put)).toContain('已记住');

    const hit = await recall.execute('t2', { query: '改价规则' });
    expect(JSON.stringify(hit)).toContain('改价前必须先确认');

    const miss = await recall.execute('t3', { query: '完全不相关词组' });
    expect(JSON.stringify(miss)).toContain('没有相关记忆');
  });

  it('remember 非法 kind → 返回失败文本而非抛错', async () => {
    const [, remember] = createMemoryTools('ws-tools');
    const res = await remember.execute('t1', { kind: 'nonsense', content: 'x' });
    expect(JSON.stringify(res)).toContain('记住失败');
  });
});

// ── 确认回路 ──────────────────────────────────────────────────────────

describe('PermissionLoop', () => {
  it('request → confirm(true) 执行；重复确认 not_found', async () => {
    permissionLoop.registerExecutor('demo', (args) => `done:${args.v}`);
    const a = permissionLoop.request({ tool: 'demo', args: { v: 1 }, summary: '做一件事', sessionKey: 'k' });
    expect(permissionLoop.pendingIds()).toContain(a.id);
    const out = await permissionLoop.confirm(a.id, true);
    expect(out).toEqual({ status: 'executed', resultText: 'done:1' });
    expect((await permissionLoop.confirm(a.id, true)).status).toBe('not_found');
  });

  it('confirm(false) 取消，执行器不被调用', async () => {
    let executed = 0;
    permissionLoop.registerExecutor('demo2', () => {
      executed++;
      return 'x';
    });
    const a = permissionLoop.request({ tool: 'demo2', args: {}, summary: 's' });
    const out = await permissionLoop.confirm(a.id, false);
    expect(out.status).toBe('cancelled');
    expect(executed).toBe(0);
  });

  it('onRequest 监听器收到登记事件', async () => {
    const seen: string[] = [];
    const off = permissionLoop.onRequest((a) => seen.push(a.id));
    const a = permissionLoop.request({ tool: 'demo3', args: {}, summary: 's' });
    off();
    expect(seen).toContain(a.id);
    await permissionLoop.confirm(a.id, false);
  });

  it('确认请求保留发起成员，供共享工作区展示与审计', async () => {
    const a = turnContext.run(
      { workspaceId: 'ws-team', sessionKey: 'channel:web#account:ws-team#conv:default', actorUserId: 'user-1' },
      () => permissionLoop.request({ tool: 'demo3', args: {}, summary: '成员发起的动作' }),
    );
    expect(a.requestedBy).toBe('user-1');
    await permissionLoop.confirm(a.id, false);
  });

  it('执行器抛错 → 返回 failed，且待办放回可重试', async () => {
    let call = 0;
    permissionLoop.registerExecutor('demo-fail', (args) => {
      call++;
      if (call === 1) throw new Error('后端暂时不可用');
      return `成功:${args.v}`;
    });
    const a = permissionLoop.request({ tool: 'demo-fail', args: { v: 2 }, summary: 's', sessionKey: 'k' });
    // 第一次确认：执行器抛错 → failed，且待办保留（仍在 pendingIds）
    const first = await permissionLoop.confirm(a.id, true);
    expect(first.status).toBe('failed');
    expect(permissionLoop.pendingIds()).toContain(a.id);
    // 第二次确认：执行器已恢复 → executed，待办清除
    const second = await permissionLoop.confirm(a.id, true);
    expect(second).toEqual({ status: 'executed', resultText: '成功:2' });
    expect(permissionLoop.pendingIds()).not.toContain(a.id);
  });
});

// ── 迁移 v4：chat_messages 可用 ───────────────────────────────────────

describe('迁移 v4', () => {
  let db: DatabaseType;
  let cleanup: () => void;

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniclaw-v4-test-'));
    const dbPath = path.join(tmpDir, 't.db');
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    initDatabase(db);
    cleanup = () => {
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
      resetDatabaseForTest();
    };
  });

  afterEach(() => cleanup());

  it('新库版本头为 v4，chat_messages 可写入与读取', () => {
    const ver = db.prepare("SELECT value FROM router_state WHERE key='schema_version'").get() as { value: string };
    expect(Number(ver.value)).toBe(CURRENT_SCHEMA_VERSION);
    const m = appendChatMessage(db, { sessionKey: 'channel:web:default', role: 'user', content: 'hi' });
    const rows = listChatMessages(db, { sessionKey: 'channel:web:default' });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(m.id);
    expect(rows[0].content).toBe('hi');
  });
});
