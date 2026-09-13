/**
 * CrewClaw 工作台启动入口：Web 应用 + 渠道网关。
 *  - Web：Hono 托管前端与身份/记忆/对话 API（src/server.ts）。
 *  - 网关：配置了渠道凭据后自动常驻连接（无凭据联调可用 GATEWAY_MOCK 挂离线渠道），
 *    入站消息按复合会话键路由到独立会话；未配置任何渠道时只起 Web，不报错。
 *  - 身份变更 → 网关会话全部重建，下一回合用新身份。
 */
import 'dotenv/config';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { createApp, ensureDefaultProfile, DEFAULT_PROFILE_ID, DEFAULT_WORKSPACE_ID } from './server.js';
import { getDatabase } from './core/database.js';
import { buildPersonaPrompt } from './agent/persona.js';
import { appendChatMessage, ensureWorkspaceProfile } from './core/models.js';
import { createAgentFactory, PROJECT_ROOT, type AgentFactory } from './agent/agent-runtime.js';
import { getProviderConfig } from './agent/provider-config.js';
import { SessionRouter } from './channels/session-router.js';
import { startGateway, buildChannelInstance, type GatewayChannel, type GatewayHandle } from './channels/gateway.js';
import { allTools } from './farm/tools.js';
import { createMemoryTools } from './memory/memory-tools.js';
import { permissionLoop } from './permissions/permission-loop.js';
import { decryptJson } from './core/secret-box.js';
import { FeishuChannel } from './channels/feishu-channel.js';
import { DingTalkChannel } from './channels/dingtalk-channel.js';
import type { IMChannel } from './channels/channel.js';

const app = createApp({
  onPersonaChanged: () => {
    void gatewaySupervisor?.reload();
  },
  onChannelsChanged: () => {
    void gatewaySupervisor?.reload();
  },
});

const PORT = Number(process.env.PORT || 3000);
serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`CrewClaw 工作台已启动: http://127.0.0.1:${info.port}`);
  void bootGateway();
});

// ── 渠道网关 ──────────────────────────────────────────────────────────

function bindChannel(ch: IMChannel & { onInbound(fn: never): void }): GatewayChannel {
  return { channel: ch, bind: (fn) => ch.onInbound(fn as never) };
}

/** 部署者渠道：环境变量配置（GATEWAY_MOCK 可离线演示） */
function channelsFromEnv(systemWorkspaceId?: string): GatewayChannel[] {
  const mockList = (process.env.GATEWAY_MOCK ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const out: GatewayChannel[] = [];

  // 配置了真实凭据即走真实长连接；显式 FEISHU_MOCK=1 / DINGTALK_MOCK=1 时切离线渠道联调
  const feishuReal = !!process.env.FEISHU_APP_ID && !!process.env.FEISHU_APP_SECRET && process.env.FEISHU_MOCK !== '1';
  if (feishuReal || mockList.includes('feishu')) {
    out.push({ ...bindChannel(new FeishuChannel({ mock: !feishuReal })), workspaceId: systemWorkspaceId });
  }
  const dtReal = !!process.env.DINGTALK_CLIENT_ID && !!process.env.DINGTALK_CLIENT_SECRET && process.env.DINGTALK_MOCK !== '1';
  if (dtReal || mockList.includes('dingtalk')) {
    out.push({ ...bindChannel(new DingTalkChannel({ mock: !dtReal })), workspaceId: systemWorkspaceId });
  }
  return out;
}

/** 各工作区自配渠道：解密凭据并实例化（解密失败的跳过并告警，不拖垮整个网关） */
function channelsFromWorkspaces(): GatewayChannel[] {
  const rows = getDatabase()
    .prepare('SELECT * FROM workspace_channels WHERE enabled = 1')
    .all() as Array<Record<string, unknown>>;
  const out: GatewayChannel[] = [];
  for (const r of rows) {
    try {
      const creds = decryptJson<Record<string, string>>(r.credentials as string);
      const accountId = (r.account_id as string) || `ws-${String(r.workspace_id).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8)}`;
      const ch = buildChannelInstance(r.kind as string, creds, accountId);
      out.push({ ...bindChannel(ch as IMChannel & { onInbound(fn: never): void }), workspaceId: r.workspace_id as string });
    } catch (e) {
      console.error(
        `[gateway] 工作区渠道 ${r.kind}(${String(r.workspace_id).slice(0, 8)}) 加载失败，已跳过:`,
        e instanceof Error ? e.message : e,
      );
    }
  }
  return out;
}

let gatewaySupervisor: { reload(): Promise<void>; handle: GatewayHandle | null } | null = null;

async function bootGateway(): Promise<void> {
  const db = () => getDatabase();
  const firstWs = db().prepare('SELECT id FROM workspaces ORDER BY created_at LIMIT 1').get() as
    | { id: string }
    | undefined;
  const systemWs = firstWs?.id;
  if (channelsFromEnv(systemWs).length + channelsFromWorkspaces().length === 0) {
    console.log('[gateway] 未配置任何渠道凭据（或 GATEWAY_MOCK），网关未启动');
    return;
  }
  let factory: AgentFactory | null = null;
  let router: SessionRouter | null = null;
  let handle: GatewayHandle | null = null;

  async function build(): Promise<GatewayHandle> {
    // 渠道清单每次重建时现读（身份/渠道变更 reload 即生效）
    const channels = [...channelsFromEnv(systemWs), ...channelsFromWorkspaces()];
    const profileId = firstWs ? ensureWorkspaceProfile(db(), firstWs.id) : (ensureDefaultProfile(db()), DEFAULT_PROFILE_ID);
    const persona = buildPersonaPrompt(db(), profileId);
    // 渠道回合与 Web 对话共用同一套模型接入配置（models.json/auth.json 优先，.env 兜底）
    const provider = getProviderConfig(db(), path.join(PROJECT_ROOT, 'agent'));
    factory = await createAgentFactory({
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      modelId: provider.modelId,
      providerId: 'custom',
      systemPrompt: persona.fullPrompt,
      // 记忆工具默认挂部署者工作区；回合内 ALS 上下文优先（工作区渠道按归属取数）
      customTools: [...allTools, ...createMemoryTools(systemWs ?? DEFAULT_WORKSPACE_ID)],
    });
    router = new SessionRouter(factory.createSession);
    return startGateway({
      channels,
      router,
      requireMention: process.env.GROUP_REQUIRE_MENTION !== '0',
      appendMessage: (key, role, content, meta) =>
        appendChatMessage(db(), { sessionKey: key, role, content, meta }),
      beforeTurn: (key) => {
        permissionLoop.currentSessionKey = key;
      },
      getAgentId: (wsId) => {
        try { return ensureWorkspaceProfile(db(), wsId); } catch { return undefined; }
      },
    });
  }

  handle = await build().catch((e) => {
    console.error('[gateway] 启动失败:', e instanceof Error ? e.message : e);
    return null;
  });
  if (!handle) return;

  const kinds = [...channelsFromEnv(systemWs), ...channelsFromWorkspaces()]
    .map((c) => c.channel.kind)
    .join(', ');
  console.log(`[gateway] 渠道已常驻: ${kinds}（群聊需 @${process.env.GROUP_REQUIRE_MENTION === '0' ? '关' : '开'}）`);

  gatewaySupervisor = {
    handle,
    async reload() {
      // 身份或渠道配置变了：清空旧会话、按新配置重挂载（连接随之重建）
      await router?.clear();
      handle = await build();
      console.log('[gateway] 配置已更新，网关已重挂载');
    },
  };
}