/**
 * 飞书渠道适配器。
 *
 * 设计要点：
 *  - 实现最小 IMChannel 契约；收到 im.message.receive_v1 事件 → 解析文本 → 交上层 Agent。
 *  - 真实模式用 @larksuiteoapi/node-sdk 的 Client + WSClient.start({ eventDispatcher })。
 *  - 提供 mock 驱动器：在无真实凭据的情况下走通"飞书群消息 → Agent → 回发"链路。
 *    便于演示与测试；真实凭据到位后切换。
 *  - 会话身份按复合键归属（Web 与飞书各自独立会话；同平台多 Bot 按 accountId 分流；
 *    话题群消息携带 threadId，与主会话隔离）。
 */
import * as lark from '@larksuiteoapi/node-sdk';
import { buildSessionKey, type IMChannel } from './channel.js';

export interface FeishuConfig {
  appId?: string;
  appSecret?: string;
  /** 账号身份：同平台多 Bot 时区分实例（真实部署可直接用 appId 作账号身份） */
  accountId?: string;
  /** true → 用 mock 驱动器（不依赖真实凭据）；false → 真实长连接 */
  mock?: boolean;
}

export type FeishuMessage = {
  kind: string;
  conversationId: string;
  text: string;
  /** 本条消息所属 Bot 账号（复合会话键的 account 维） */
  accountId?: string;
  /** 话题群线程 id（复合会话键的 thread 维；普通群聊无此字段） */
  threadId?: string;
  /** 会话形态：oc_ 前缀 = 群聊，on_ = 单聊（群聊是否要求 @ 由网关门控） */
  chatType?: 'group' | 'p2p';
  /** 是否 @ 了机器人（群聊门控依据） */
  mentioned?: boolean;
  /** 渠道侧发送者标识，用于操作审计。 */
  actorUserId?: string;
};

const env = () => ({
  appId: process.env.FEISHU_APP_ID || '',
  appSecret: process.env.FEISHU_APP_SECRET || '',
  accountId: process.env.FEISHU_ACCOUNT_ID || '',
  mock: (process.env.FEISHU_MOCK ?? '1') === '1',
});

/** 从飞书 receive 事件 payload 提取文本（精简，忽略富文本/图片） */
function textFromEvent(event: { message?: { content?: string; chat_id?: string } }): string {
  const content = event?.message?.content;
  if (!content) return '';
  try {
    const parsed = JSON.parse(content);
    return parsed?.text ?? '';
  } catch {
    return content;
  }
}

export class FeishuChannel implements IMChannel {
  readonly kind = 'feishu';
  readonly capabilities = { streaming: false }; // 飞书流式卡片为可选能力，本版不实现
  /** 账号身份（未配置时 undefined → 复合键退化为旧格式，向后兼容） */
  readonly accountId?: string;
  private cfg: FeishuConfig & { appId: string; appSecret: string; mock: boolean };
  private client: lark.Client | null = null;
  private ws: lark.WSClient | null = null;
  private connected = false;
  private onMessage: ((m: FeishuMessage) => void) | null = null;

  constructor(cfg: FeishuConfig = {}) {
    const e = env();
    this.cfg = {
      appId: cfg.appId ?? e.appId,
      appSecret: cfg.appSecret ?? e.appSecret,
      accountId: cfg.accountId ?? e.accountId,
      mock: cfg.mock ?? e.mock,
    };
    if (this.cfg.accountId) this.accountId = this.cfg.accountId;
  }

  /** 注册收到消息的回调（由上层接入 Agent） */
  onInbound(fn: (m: FeishuMessage) => void): void {
    this.onMessage = fn;
  }

  async connect(): Promise<void> {
    if (this.cfg.mock) {
      this.connected = true;
      console.log('[feishu:mock] 飞书渠道已连接（mock 模式）');
      return;
    }
    if (!this.cfg.appId || !this.cfg.appSecret) {
      throw new Error('真实飞书模式需要 FEISHU_APP_ID / FEISHU_APP_SECRET');
    }
    this.client = new lark.Client({
      appId: this.cfg.appId,
      appSecret: this.cfg.appSecret,
      appType: lark.AppType.SelfBuild,
      domain: lark.Domain.Feishu,
    });
    this.ws = new lark.WSClient({
      appId: this.cfg.appId,
      appSecret: this.cfg.appSecret,
    });
    const self = this;
    await this.ws.start({
      eventDispatcher: {
        'im.message.receive_v1': async (data: any) => {
          const event = data?.event ?? data;
          const conversationId = event?.message?.chat_id ?? 'unknown';
          const text = textFromEvent(event);
          if (!text) return;
          // 话题群消息带 thread_id → 复合会话键按线程隔离；普通群聊无此字段
          const threadId: string | undefined = event?.message?.thread_id || undefined;
          // oc_ 前缀 = 群聊；mentions 非空 = @ 了机器人（群聊门控依据）
          const chatType = conversationId.startsWith('oc_') ? 'group' : 'p2p';
          const mentioned = Array.isArray(event?.message?.mentions) && event.message.mentions.length > 0;
          const senderId = event?.sender?.sender_id?.open_id ?? event?.sender?.sender_id?.user_id;
          self.onMessage?.({
            kind: 'feishu', conversationId, text, accountId: self.accountId, threadId, chatType, mentioned,
            actorUserId: senderId ? `im:feishu:${senderId}` : undefined,
          });
        },
      },
    } as any);
    this.connected = true;
    console.log('[feishu] 飞书长连接已建立');
  }

  isConnected(): boolean {
    return this.connected;
  }

  async disconnect(): Promise<void> {
    if (this.ws) {
      try {
        await this.ws.close();
      } catch {
        /* ignore */
      }
    }
    this.connected = false;
  }

  async sendMessage(conversationId: string, text: string): Promise<void> {
    if (this.cfg.mock) {
      console.log(
        `[feishu:mock] 回发到 ${buildSessionKey({ kind: 'feishu', accountId: this.accountId, conversationId })} → ${text}`,
      );
      return;
    }
    if (!this.client) throw new Error('feishu client 未初始化');
    await this.client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: conversationId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
    } as any);
  }

  /** mock 驱动器：模拟收到一条飞书消息（可选 threadId/群聊形态/@ 状态） */
  async simulateInbound(
    conversationId: string,
    text: string,
    opts: { threadId?: string; chatType?: 'group' | 'p2p'; mentioned?: boolean } = {},
  ): Promise<void> {
    if (!this.onMessage) throw new Error('尚未注册 onInbound 回调');
    this.onMessage({
      kind: 'feishu',
      conversationId,
      text,
      accountId: this.accountId,
      threadId: opts.threadId,
      chatType: opts.chatType ?? (conversationId.startsWith('oc_') ? 'group' : 'p2p'),
      mentioned: opts.mentioned,
    });
  }
}
