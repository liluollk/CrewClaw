/**
 * 渠道网关：让 IM 渠道常驻在线，把入站消息路由到「按复合会话键隔离」的 Agent 会话。
 *
 * 链路：渠道消息 → mention 门控（群聊必须 @）→ 复合键 → SessionRouter（同键串行）
 *       → runTurn → 历史落库 → 回发原对话。
 *
 * 可注入设计：channels / router / appendMessage 全部可替换，测试不需要真实凭据与 LLM。
 */
import { buildSessionKey } from './channel.js';
import type { SessionRouter } from './session-router.js';
import { runTurn } from '../agent/agent-runtime.js';
import type { IMChannel } from './channel.js';
import { FeishuChannel } from './feishu-channel.js';
import { DingTalkChannel } from './dingtalk-channel.js';
import { turnContext } from '../core/runtime-context.js';

/** 按凭据构建真实模式渠道实例（工作区自配渠道用；字段合法性由调用方校验） */
export function buildChannelInstance(
  kind: string,
  creds: Record<string, string>,
  accountId?: string,
): IMChannel {
  switch (kind) {
    case 'feishu':
      return new FeishuChannel({
        appId: creds.appId,
        appSecret: creds.appSecret,
        accountId,
        mock: false,
      });
    case 'dingtalk':
      return new DingTalkChannel({
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
        accountId,
        mock: false,
      });
    default:
      throw new Error(`不支持的渠道: ${kind}`);
  }
}

export interface GatewayMessage {
  kind: string;
  conversationId: string;
  text: string;
  accountId?: string;
  threadId?: string;
  chatType?: 'group' | 'p2p';
  mentioned?: boolean;
  /** 渠道侧发送者标识；用于工具审计，不等同于 Web users.id。 */
  actorUserId?: string;
}

/** 网关视角的渠道：契约通道 + 统一的入站绑定口 + 归属工作区 */
export interface GatewayChannel {
  channel: IMChannel;
  /** 该渠道归属的工作区（会话/记忆/历史按它隔离；undefined = 部署者系统空间） */
  workspaceId?: string;
  bind(fn: (m: GatewayMessage) => void): void;
}

export interface GatewayDeps {
  channels: GatewayChannel[];
  router: SessionRouter;
  /** 历史落库（默认关闭；注入 appendChatMessage 即启用） */
  appendMessage?: (sessionKey: string, role: 'user' | 'assistant' | 'tool' | 'system', content: string, meta?: Record<string, unknown>) => void;
  /** 群聊是否必须 @ 机器人才响应（默认 true；钉钉天然只收 @ 消息） */
  requireMention?: boolean;
  /** 每轮前置钩子（如设置权限回路当前会话键），可注入 */
  beforeTurn?: (sessionKey: string) => void;
  /** 按工作区反查绑定的 Agent ID（用于审计上下文注入） */
  getAgentId?: (workspaceId: string) => string | undefined;
}

export interface GatewayHandle {
  stop(): Promise<void>;
  router: SessionRouter;
}

export async function startGateway(deps: GatewayDeps): Promise<GatewayHandle> {
  const requireMention = deps.requireMention ?? true;
  const append = deps.appendMessage;

  async function handleInbound(ch: GatewayChannel, m: GatewayMessage): Promise<void> {
    // 群聊门控：没 @ 机器人就不打断群聊（单聊不要求）
    if (m.chatType === 'group' && requireMention && m.mentioned !== true) return;
    if (!m.text.trim()) return;

    const key = buildSessionKey({
      kind: m.kind,
      accountId: m.accountId,
      conversationId: m.conversationId,
      threadId: m.threadId,
    });
    append?.(key, 'user', m.text, { channel: m.kind, conversationId: m.conversationId });
    deps.beforeTurn?.(key);
    try {
      await deps.router.run(key, async (session) => {
        // 回合上下文：工具（记忆读写/确认登记）按渠道归属的工作区取数
        await turnContext.run({
          workspaceId: ch.workspaceId,
          sessionKey: key,
          agentId: ch.workspaceId ? deps.getAgentId?.(ch.workspaceId) : undefined,
          actorUserId: m.actorUserId,
          triggerType: 'message',
        }, async () => {
          const { text: reply } = await runTurn(session, m.text);
          const out = reply || '（这轮没有产出回复）';
          append?.(key, 'assistant', out, {});
          await ch.channel.sendMessage(m.conversationId, out);
        });
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      append?.(key, 'system', `处理失败：${msg}`, {});
      console.error(`[gateway:${m.kind}] 回合失败（${key}）:`, msg);
    }
  }

  for (const ch of deps.channels) {
    ch.bind((m) => {
      void handleInbound(ch, m);
    });
    if (!ch.channel.isConnected()) {
      await ch.channel.connect();
    }
  }

  return {
    router: deps.router,
    async stop() {
      for (const ch of deps.channels) {
        try {
          await ch.channel.disconnect();
        } catch {
          /* ignore */
        }
      }
      await deps.router.clear();
    },
  };
}
