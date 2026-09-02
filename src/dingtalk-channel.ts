/**
 * 钉钉渠道接入（官方 Stream SDK，第三个渠道适配器）。
 *
 * 设计要点：
 *  - 使用 dingtalk-stream-sdk-nodejs 的 DWClient Stream 模式 WebSocket。
 *  - 实现 IMChannel 契约：connect/sendMessage/isConnected。
 *  - 事件 → onInbound：bot/群消息回调解析文本 + conversationId。
 *  - 会话键：复合键 channel:dingtalk[:#account:<a>]#conv:<conversationId>
 *    （与飞书互不混用；同平台多 Bot 应用按 clientId 配 accountId 分流；
 *    钉钉机器人回调无话题线程概念 → 不建模 thread 维，如实按平台能力接线）。
 *  - 提供 mock 驱动器（simulateInbound）供测试与离线验证。
 *  - capabilities.streaming=false（钉钉 AI Card 可后续加）。
 *  - setTyping 不实现（钉钉 Stream SDK 无对应能力）。
 */
import { DWClient, TOPIC_ROBOT } from 'dingtalk-stream-sdk-nodejs';
import type { RobotMessage } from 'dingtalk-stream-sdk-nodejs';
import { buildSessionKey, type IMChannel } from './channel.js';

export interface DingTalkConfig {
  clientId?: string;
  clientSecret?: string;
  /** 账号身份：同平台挂多个企业内部应用时区分实例 */
  accountId?: string;
  /** true → mock 模式（不依赖真实凭据） */
  mock?: boolean;
}

export type DingTalkMessage = {
  kind: 'dingtalk';
  conversationId: string;
  text: string;
  accountId?: string;
  /** 会话形态：conversationType '1'=单聊、'2'=群聊 */
  chatType?: 'group' | 'p2p';
  /** 钉钉机器人只在被 @ 时收到消息，恒为 true */
  mentioned?: boolean;
  /** 渠道侧发送者标识，用于操作审计。 */
  actorUserId?: string;
};

const env = () => ({
  clientId: process.env.DINGTALK_CLIENT_ID || '',
  clientSecret: process.env.DINGTALK_CLIENT_SECRET || '',
  accountId: process.env.DINGTALK_ACCOUNT_ID || '',
  mock: (process.env.DINGTALK_MOCK ?? '1') === '1',
});

/** 钉钉开放平台 REST API 基础 URL */
const DINGTALK_API_BASE = 'https://api.dingtalk.com';

/**
 * 从钉钉机器人消息回调解析文本内容。
 * 支持 text 类型消息。
 */
function textFromRobotMessage(
  data: string,
): { conversationId: string; text: string; chatType: 'group' | 'p2p'; actorUserId?: string } | null {
  try {
    const msg: RobotMessage = JSON.parse(data);
    if (msg.msgtype === 'text' && 'text' in msg && msg.text?.content) {
      // 去除 @机器人 前缀（钉钉群聊中 @机器人 会带机器人名称）
      let content = msg.text.content;
      // 去除可能的 @机器人 前缀
      content = content.replace(/^@[\u4e00-\u9fa5a-zA-Z0-9_-]+\s*/, '').trim();
      // conversationType：'1'=单聊、'2'=群聊
      const chatType = (msg as { conversationType?: string }).conversationType === '1' ? 'p2p' : 'group';
      const senderId = (msg as { senderId?: string; senderStaffId?: string }).senderId
        ?? (msg as { senderStaffId?: string }).senderStaffId;
      return { conversationId: msg.conversationId, text: content, chatType, actorUserId: senderId ? `im:dingtalk:${senderId}` : undefined };
    }
    return null;
  } catch {
    return null;
  }
}

export class DingTalkChannel implements IMChannel {
  readonly kind = 'dingtalk';
  readonly capabilities = { streaming: false };
  readonly accountId?: string;
  private cfg: { clientId: string; clientSecret: string; accountId?: string; mock: boolean };
  private client: DWClient | null = null;
  private connected = false;
  private onMessage: ((m: DingTalkMessage) => void) | null = null;

  constructor(cfg: DingTalkConfig = {}) {
    const e = env();
    this.cfg = {
      clientId: cfg.clientId ?? e.clientId,
      clientSecret: cfg.clientSecret ?? e.clientSecret,
      accountId: cfg.accountId ?? e.accountId,
      mock: cfg.mock ?? e.mock,
    };
    if (this.cfg.accountId) this.accountId = this.cfg.accountId;
  }

  /** 注册收到消息的回调（由上层接入 Agent） */
  onInbound(fn: (m: DingTalkMessage) => void): void {
    this.onMessage = fn;
  }

  async connect(): Promise<void> {
    if (this.cfg.mock) {
      this.connected = true;
      console.log('[dingtalk:mock] 钉钉渠道已连接（mock 模式）');
      return;
    }
    if (!this.cfg.clientId || !this.cfg.clientSecret) {
      throw new Error('真实钉钉模式需要 DINGTALK_CLIENT_ID / DINGTALK_CLIENT_SECRET');
    }
    this.client = new DWClient({
      clientId: this.cfg.clientId,
      clientSecret: this.cfg.clientSecret,
    });
    const self = this;
    this.client.registerCallbackListener(TOPIC_ROBOT, (downstream) => {
      // ACK 钉钉服务端回调：SDK 的 onCallback 只 emit 不自动 ack，
      // 不 ack 会导致服务端不断重投同一条消息（Agent 重复执行）。
      try {
        self.client?.send(downstream.headers.messageId, { status: 'SUCCESS' });
      } catch { /* ack 失败不阻塞消息处理 */ }
      const parsed = textFromRobotMessage(downstream.data);
      if (!parsed || !parsed.text) return;
      self.onMessage?.({
        kind: 'dingtalk',
        conversationId: parsed.conversationId,
        text: parsed.text,
        accountId: self.accountId,
        chatType: parsed.chatType,
        mentioned: true,
        actorUserId: parsed.actorUserId,
      });
    });
    await this.client.connect();
    this.connected = true;
    console.log('[dingtalk] 钉钉 Stream 长连接已建立');
  }

  isConnected(): boolean {
    return this.connected;
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.disconnect();
    }
    this.connected = false;
  }

  async sendMessage(conversationId: string, text: string): Promise<void> {
    if (this.cfg.mock) {
      console.log(
        `[dingtalk:mock] 回发到 ${buildSessionKey({ kind: 'dingtalk', accountId: this.accountId, conversationId })} → ${text}`,
      );
      return;
    }
    // 真实模式：通过钉钉开放平台 REST API 发送消息
    // 需要先用 clientId/clientSecret 获取 access_token
    const token = await this.getAccessToken();
    const res = await fetch(
      `${DINGTALK_API_BASE}/v1.0/im/robot/singleSend/${conversationId}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-acs-dingtalk-access-token': token,
        },
        body: JSON.stringify({
          msgKey: 'sampleText',
          msgParam: JSON.stringify({ content: text }),
        }),
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`钉钉消息发送失败: ${res.status} ${body.slice(0, 200)}`);
    }
  }

  /** mock 驱动器：模拟收到一条钉钉消息（可选群聊形态；钉钉机器人必然 @） */
  async simulateInbound(
    conversationId: string,
    text: string,
    opts: { chatType?: 'group' | 'p2p' } = {},
  ): Promise<void> {
    if (!this.onMessage) throw new Error('尚未注册 onInbound 回调');
    this.onMessage({
      kind: 'dingtalk',
      conversationId,
      text,
      accountId: this.accountId,
      chatType: opts.chatType ?? 'group',
      mentioned: true,
    });
  }

  /**
   * 获取钉钉 access_token。
   * 使用 clientId/clientSecret 调用 OAuth 接口。
   */
  private async getAccessToken(): Promise<string> {
    const res = await fetch(`${DINGTALK_API_BASE}/v1.0/oauth2/accessToken`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        appKey: this.cfg.clientId,
        appSecret: this.cfg.clientSecret,
      }),
    });
    const json = (await res.json()) as { accessToken?: string };
    if (!json.accessToken) {
      throw new Error(`钉钉 access_token 获取失败: ${JSON.stringify(json).slice(0, 200)}`);
    }
    return json.accessToken;
  }
}
