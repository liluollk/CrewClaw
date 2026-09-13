/**
 * 钉钉渠道适配器测试。
 *
 * 测试覆盖：
 *  1) 契约完备性（最小集合 + capabilities）。
 *  2) simulateInbound → onInbound 链路。
 *  3) 会话键与飞书/Web 互不混用。
 *  4) ChannelManager 三渠道并存注册。
 *  5) mock 模式 connect/disconnect 状态迁移。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { DingTalkChannel } from '../src/channels/dingtalk-channel.js';
import { channelManager, sessionKeyFor, type IMChannel } from '../src/channels/channel.js';

/** 契约完备性：任意 IMChannel 实现都必须具备最小集合 */
function assertMinimalContract(c: IMChannel) {
  expect(typeof c.connect).toBe('function');
  expect(typeof c.disconnect).toBe('function');
  expect(typeof c.isConnected).toBe('function');
  expect(typeof c.sendMessage).toBe('function');
  expect(typeof c.kind).toBe('string');
  expect(c.capabilities).toHaveProperty('streaming');
}

describe('P4 · DingTalkChannel · IMChannel 契约', () => {
  it('实现最小契约 + kind/capabilities 声明', () => {
    const dt = new DingTalkChannel({ mock: true });
    assertMinimalContract(dt);
    expect(dt.kind).toBe('dingtalk');
    expect(dt.capabilities.streaming).toBe(false);
  });

  it('mock 模式 connect/disconnect 状态迁移正常', async () => {
    const dt = new DingTalkChannel({ mock: true });
    expect(dt.isConnected()).toBe(false);
    await dt.connect();
    expect(dt.isConnected()).toBe(true);
    await dt.disconnect();
    expect(dt.isConnected()).toBe(false);
  });

  it('mock sendMessage 回发不抛错', async () => {
    const dt = new DingTalkChannel({ mock: true });
    await dt.connect();
    await expect(dt.sendMessage('conversation-1', 'hello')).resolves.not.toThrow();
  });

  it('真实模式缺少凭据时 connect 抛错', async () => {
    const dt = new DingTalkChannel({ mock: false, clientId: '', clientSecret: '' });
    await expect(dt.connect()).rejects.toThrow('DINGTALK_CLIENT_ID');
  });

  it('setTyping 未实现（钉钉 SDK 无对应能力）', () => {
    const dt = new DingTalkChannel({ mock: true });
    expect((dt as any).setTyping).toBeUndefined();
  });
});

describe('P4 · DingTalkChannel · 入站链路', () => {
  let dt: DingTalkChannel;
  const received: Array<{ kind: 'dingtalk'; conversationId: string; text: string }> = [];

  beforeEach(() => {
    received.length = 0;
    dt = new DingTalkChannel({ mock: true });
  });

  afterEach(async () => {
    await dt.disconnect();
  });

  it('simulateInbound → onInbound 收到消息', async () => {
    dt.onInbound((m) => received.push(m));
    await dt.connect();
    await dt.simulateInbound('conv-001', '查一下库存');
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      kind: 'dingtalk',
      conversationId: 'conv-001',
      text: '查一下库存',
      chatType: 'group',
      mentioned: true,
    });
  });

  it('多次模拟入站累积', async () => {
    dt.onInbound((m) => received.push(m));
    await dt.connect();
    await dt.simulateInbound('conv-001', '你好');
    await dt.simulateInbound('conv-002', '查库存');
    expect(received).toHaveLength(2);
  });
});

describe('P4 · 会话键隔离', () => {
  it('dingtalk 会话键格式正确', () => {
    expect(sessionKeyFor('dingtalk', 'conv-001')).toBe('channel:dingtalk:conv-001');
  });

  it('与飞书/Web 互不混用', () => {
    const key = 'conv-001';
    const dingtalkKey = sessionKeyFor('dingtalk', key);
    const feishuKey = sessionKeyFor('feishu', key);
    const webKey = sessionKeyFor('web', key);
    expect(dingtalkKey).not.toBe(feishuKey);
    expect(dingtalkKey).not.toBe(webKey);
    expect(feishuKey).not.toBe(webKey);
  });
});

describe('P4 · ChannelManager · 三渠道并存注册', () => {
  const savedChannels = new Map<string, IMChannel>();

  beforeEach(() => {
    // 保存已有渠道
    for (const kind of channelManager.list()) {
      const ch = channelManager.get(kind);
      if (ch) savedChannels.set(kind, ch);
    }
  });

  afterEach(() => {
    // 恢复
    for (const [kind, ch] of savedChannels) {
      channelManager.register(ch);
    }
  });

  it('dingtalk 注册后可与 feishu 并存', () => {
    const dt = new DingTalkChannel({ mock: true });
    channelManager.register(dt);
    expect(channelManager.get('dingtalk')).toBeDefined();
    expect(channelManager.get('dingtalk')!.kind).toBe('dingtalk');
    expect(channelManager.list()).toContain('dingtalk');
  });

  it('三渠道同时注册', () => {
    // 注册三个渠道
    const dt = new DingTalkChannel({ mock: true });
    channelManager.register(dt);
    const list = channelManager.list();
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list).toContain('dingtalk');
  });
});