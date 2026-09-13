/**
 * 复合会话键测试：渠道 + 账号 + 对话 + 话题 四维寻址。
 *
 * 测试覆盖：
 *  1) build：单账号无话题退化为旧格式（向后兼容，零迁移）；各维度组合的 canonical 形。
 *  2) parse：旧/新格式解析；非法输入 fail-fast；build↔parse 往返一致。
 *  3) 隔离语义：同群不同 Bot、同群不同话题 → 键必然不同（互不串扰的代数基础）。
 *  4) ChannelManager：同 kind 多账号并存、精确选路、歧义拒绝、同键替换幂等。
 *  5) 适配器接线：飞书/钉钉 mock 链路携带 accountId/threadId。
 *  6) 会话目录：workspace_runtime_sessions 按复合键查询，同群双 Bot 各自一条会话。
 */
import { describe, expect, it, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {
  buildSessionKey,
  parseSessionKey,
  sessionKeyFor,
  ChannelManager,
  type IMChannel,
} from '../src/channels/channel.js';
import { FeishuChannel } from '../src/channels/feishu-channel.js';
import { DingTalkChannel } from '../src/channels/dingtalk-channel.js';
import { initDatabase, resetDatabaseForTest } from '../src/core/database.js';
import {
  createAgentProfile,
  createWorkspace,
  recordRuntimeSession,
  getRuntimeSessionByKey,
} from '../src/core/models.js';

// ── build：canonical 形与向后兼容 ─────────────────────────────────────

describe('JID · buildSessionKey', () => {
  it('无账号无话题 → 退化为旧格式（历史会话键零迁移）', () => {
    expect(buildSessionKey({ kind: 'feishu', conversationId: 'oc_1' })).toBe(
      'channel:feishu:oc_1',
    );
  });

  it('sessionKeyFor 兼容入口与 buildSessionKey 等价', () => {
    expect(sessionKeyFor('web', 'user-1')).toBe(
      buildSessionKey({ kind: 'web', conversationId: 'user-1' }),
    );
  });

  it('仅账号维', () => {
    expect(
      buildSessionKey({ kind: 'feishu', accountId: 'bot-a', conversationId: 'oc_1' }),
    ).toBe('channel:feishu#account:bot-a#conv:oc_1');
  });

  it('仅话题维', () => {
    expect(
      buildSessionKey({ kind: 'dingtalk', conversationId: '-100123', threadId: '42' }),
    ).toBe('channel:dingtalk#conv:-100123#thread:42');
  });

  it('账号+话题全维', () => {
    expect(
      buildSessionKey({
        kind: 'dingtalk',
        accountId: 'ops-bot',
        conversationId: '-100123',
        threadId: '42',
      }),
    ).toBe('channel:dingtalk#account:ops-bot#conv:-100123#thread:42');
  });

  it('非法输入 fail-fast', () => {
    expect(() => buildSessionKey({ kind: 'feishu:evil', conversationId: 'c' })).toThrow();
    expect(() => buildSessionKey({ kind: 'feishu#a', conversationId: 'c' })).toThrow();
    expect(() => buildSessionKey({ kind: '', conversationId: 'c' })).toThrow();
    expect(() => buildSessionKey({ kind: 'feishu', conversationId: '' })).toThrow();
    expect(() =>
      buildSessionKey({ kind: 'feishu', accountId: '  ', conversationId: 'c' }),
    ).toThrow();
  });
});

// ── parse：兼容解析与非法拒绝 ─────────────────────────────────────────

describe('JID · parseSessionKey', () => {
  it('旧格式 → kind + conversationId', () => {
    expect(parseSessionKey('channel:feishu:oc_1')).toEqual({
      kind: 'feishu',
      conversationId: 'oc_1',
    });
  });

  it('旧格式 conversationId 内嵌冒号整体保留', () => {
    expect(parseSessionKey('channel:web:user:42')).toEqual({
      kind: 'web',
      conversationId: 'user:42',
    });
  });

  it('build↔parse 往返一致（全维）', () => {
    const parts = { kind: 'feishu', accountId: 'bot-a', conversationId: 'oc_1', threadId: 'omt_9' };
    expect(parseSessionKey(buildSessionKey(parts))).toEqual(parts);
  });

  it('build↔parse 往返一致（旧格式退化形）', () => {
    const parts = { kind: 'dingtalk', conversationId: 'cid/x==:x' };
    expect(parseSessionKey(buildSessionKey(parts))).toEqual(parts);
  });

  it('非法输入拒绝：缺前缀 / 未知维度 / 重复维度 / 缺 conv', () => {
    expect(() => parseSessionKey('session:feishu:oc_1')).toThrow();
    expect(() => parseSessionKey('channel:feishu#conv:c#root:r1')).toThrow(/未知维度/);
    expect(() => parseSessionKey('channel:feishu#conv:a#conv:b')).toThrow(/重复/);
    expect(() => parseSessionKey('channel:feishu#account:bot-a')).toThrow(/#conv:/);
    expect(() => parseSessionKey('channel::oc_1')).toThrow();
  });
});

// ── 隔离语义：串扰的代数否定 ──────────────────────────────────────────

describe('JID · 隔离语义', () => {
  it('同一群、两个 Bot 账号 → 会话键不同（消息知道是谁的）', () => {
    const a = buildSessionKey({ kind: 'feishu', accountId: 'bot-a', conversationId: 'oc_group' });
    const b = buildSessionKey({ kind: 'feishu', accountId: 'bot-b', conversationId: 'oc_group' });
    expect(a).not.toBe(b);
  });

  it('同一群、主链与话题 → 会话键不同；同输入确定性相等', () => {
    const root = buildSessionKey({ kind: 'dingtalk', conversationId: '-1009', threadId: undefined });
    const thread = buildSessionKey({ kind: 'dingtalk', conversationId: '-1009', threadId: '77' });
    expect(root).not.toBe(thread);
    expect(thread).toBe(
      buildSessionKey({ kind: 'dingtalk', conversationId: '-1009', threadId: '77' }),
    );
  });
});

// ── ChannelManager：同 kind 多实例 ────────────────────────────────────

function fakeChannel(kind: string, accountId?: string): IMChannel {
  return {
    kind,
    accountId,
    capabilities: { streaming: false },
    async connect() {},
    async disconnect() {},
    isConnected: () => true,
    async sendMessage() {},
  };
}

describe('JID · ChannelManager 多账号', () => {
  it('同 kind 不同账号并存，精确选路各取各实例', () => {
    const mgr = new ChannelManager();
    const a = fakeChannel('feishu', 'bot-a');
    const b = fakeChannel('feishu', 'bot-b');
    mgr.register(a);
    mgr.register(b);
    expect(mgr.get('feishu', 'bot-a')).toBe(a);
    expect(mgr.get('feishu', 'bot-b')).toBe(b);
    expect(mgr.listByKind('feishu')).toHaveLength(2);
  });

  it('多账号未指定选路 → 歧义返回 undefined（拒绝随机挑 Bot）', () => {
    const mgr = new ChannelManager();
    mgr.register(fakeChannel('feishu', 'bot-a'));
    mgr.register(fakeChannel('feishu', 'bot-b'));
    expect(mgr.get('feishu')).toBeUndefined();
  });

  it('单账号无 account 注册 → 旧用法 get(kind) 不受影响', () => {
    const mgr = new ChannelManager();
    const dt = fakeChannel('dingtalk');
    mgr.register(dt);
    expect(mgr.get('dingtalk')).toBe(dt);
    expect(mgr.list()).toContain('dingtalk');
  });

  it('同 (kind, account) 重复注册 = 替换（幂等，旧用法保持）', () => {
    const mgr = new ChannelManager();
    const first = fakeChannel('dingtalk', 'bot-x');
    const second = fakeChannel('dingtalk', 'bot-x');
    mgr.register(first);
    mgr.register(second);
    expect(mgr.get('dingtalk', 'bot-x')).toBe(second);
    expect(mgr.listByKind('dingtalk')).toHaveLength(1);
  });

  it('单账号多实例 kind 未带 account 也能经 listByKind 唯一命中', () => {
    const mgr = new ChannelManager();
    const a = fakeChannel('feishu', 'only');
    mgr.register(a);
    expect(mgr.get('feishu')).toBe(a); // 唯一账号实例 → 无歧义便利路径
  });
});

// ── 适配器接线：mock 链路携带 account/thread 维 ──────────────────────

describe('JID · 适配器接线', () => {
  afterEach(async () => {
    resetDatabaseForTest();
  });

  it('飞书：实例 accountId 与话题 threadId 进入消息并组出复合键', async () => {
    const feishu = new FeishuChannel({ mock: true, accountId: 'bot-a' });
    const received: any[] = [];
    feishu.onInbound((m) => received.push(m));
    await feishu.connect();
    await feishu.simulateInbound('oc_group', '你好', { threadId: 'omt_5' });
    await feishu.simulateInbound('oc_group', '主链消息');
    const [topic, plain] = received;
    expect(
      buildSessionKey({
        kind: topic.kind,
        accountId: topic.accountId,
        conversationId: topic.conversationId,
        threadId: topic.threadId,
      }),
    ).toBe('channel:feishu#account:bot-a#conv:oc_group#thread:omt_5');
    expect(plain.threadId).toBeUndefined();
    expect(
      buildSessionKey({
        kind: plain.kind,
        accountId: plain.accountId,
        conversationId: plain.conversationId,
      }),
    ).toBe('channel:feishu#account:bot-a#conv:oc_group');
  });

  it('飞书：未配 accountId → 消息退化为旧格式键（兼容路径）', async () => {
    const feishu = new FeishuChannel({ mock: true });
    const received: any[] = [];
    feishu.onInbound((m) => received.push(m));
    await feishu.connect();
    await feishu.simulateInbound('oc_solo', 'hi');
    expect(
      buildSessionKey({
        kind: 'feishu',
        accountId: received[0].accountId,
        conversationId: received[0].conversationId,
      }),
    ).toBe('channel:feishu:oc_solo');
  });

  it('钉钉：多实例 accountId 分流；飞书：话题维度进入会话键', async () => {
    const dtA = new DingTalkChannel({ mock: true, accountId: 'app-a' });
    const dtB = new DingTalkChannel({ mock: true, accountId: 'app-b' });
    const seen: any[] = [];
    dtA.onInbound((m) => seen.push(m));
    dtB.onInbound((m) => seen.push(m));
    await dtA.simulateInbound('conv-1', '给A');
    await dtB.simulateInbound('conv-1', '给B');
    expect(seen).toHaveLength(2);
    const [ma, mb] = seen;
    expect(buildSessionKey({ kind: ma.kind, accountId: ma.accountId, conversationId: ma.conversationId }))
      .not.toBe(
        buildSessionKey({ kind: mb.kind, accountId: mb.accountId, conversationId: mb.conversationId }),
      );

    const fs = new FeishuChannel({ mock: true, accountId: 'bot-a' });
    let fsMsg: any = null;
    fs.onInbound((m) => (fsMsg = m));
    await fs.connect();
    await fs.simulateInbound('oc_777', '话题消息', { threadId: '3' });
    expect(
      buildSessionKey({ kind: fsMsg.kind, accountId: fsMsg.accountId, conversationId: fsMsg.conversationId, threadId: fsMsg.threadId }),
    ).toBe('channel:feishu#account:bot-a#conv:oc_777#thread:3');
  });
});

// ── 会话目录：复合键落库后按键隔离 ───────────────────────────────────

describe('JID · 会话目录按复合键隔离', () => {
  let db: DatabaseType;
  let cleanup: () => void;

  function createTempDb() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniclaw-test-'));
    const dbPath = path.join(tmpDir, 'test.db');
    const d = new Database(dbPath);
    d.pragma('journal_mode = WAL');
    d.pragma('foreign_keys = ON');
    initDatabase(d);
    const clean = () => {
      d.close();
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          fs.unlinkSync(dbPath + suffix);
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
    return { db: d, cleanup: clean };
  }

  it('同群双 Bot 各自一条 runtime 会话，按复合键精确回查', () => {
    ({ db, cleanup } = createTempDb());
    try {
      createWorkspace(db, { id: 'ws-1', name: '空间', folder: 'ws' });
      createAgentProfile(db, { id: 'prof-1', name: '助手' });
      const keyA = buildSessionKey({ kind: 'feishu', accountId: 'bot-a', conversationId: 'oc_g' });
      const keyB = buildSessionKey({ kind: 'feishu', accountId: 'bot-b', conversationId: 'oc_g' });
      recordRuntimeSession(db, { id: 'sess-a', workspaceId: 'ws-1', profileId: 'prof-1', sessionKey: keyA });
      recordRuntimeSession(db, { id: 'sess-b', workspaceId: 'ws-1', profileId: 'prof-1', sessionKey: keyB });
      expect(getRuntimeSessionByKey(db, keyA)?.id).toBe('sess-a');
      expect(getRuntimeSessionByKey(db, keyB)?.id).toBe('sess-b');
    } finally {
      cleanup();
      resetDatabaseForTest();
    }
  });
});
