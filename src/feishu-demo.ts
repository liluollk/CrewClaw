/**
 * 飞书渠道端到端验证（mock 模式）。
 *
 * 链路：simulateInbound(群消息) → FeishuChannel.onInbound → Agent(runTurn, 带工具+权限)
 *       → FeishuChannel.sendMessage 回发。
 * 真实凭据模式：FEISHU_MOCK=0 + 配置 FEISHU_APP_ID/APP_SECRET 后 connect 走真实长连接。
 * 运行：npm run feishu-demo
 */
import 'dotenv/config';
import { createPiRuntime, runTurn } from './agent-runtime.js';
import { FeishuChannel } from './feishu-channel.js';
import { allTools } from './tools.js';
import { channelManager, buildSessionKey } from './channel.js';
import { getDatabase } from './database.js';
import { buildPersonaPrompt } from './persona.js';
import { ensureDefaultProfile, DEFAULT_PROFILE_ID } from './server.js';

async function main() {
  // accountId 显式配置时进入复合会话键；未配置则退化为旧格式（向后兼容）
  const feishu = new FeishuChannel({ accountId: process.env.FEISHU_ACCOUNT_ID || undefined });
  channelManager.register(feishu);

  // 身份闭环：与 Web 工作台共用同一 Profile 管线（四段拼装 → appendSystemPrompt 注入）
  ensureDefaultProfile(getDatabase());
  const persona = buildPersonaPrompt(getDatabase(), DEFAULT_PROFILE_ID);

  // 复用同一个 Agent runtime（会话按 continueRecent 延续）
  const { session } = await createPiRuntime({
    baseUrl: process.env.MINICLAW_BASE_URL!,
    apiKey: process.env.MINICLAW_API_KEY!,
    modelId: process.env.MINICLAW_MODEL!,
    providerId: 'custom',
    sessionName: 'feishu',
    systemPrompt: persona.fullPrompt,
    customTools: allTools,
    disableBuiltinTools: true,
  });

  feishu.onInbound(async ({ conversationId, text, accountId, threadId }) => {
    // 复合会话键：渠道+账号+对话+话题 → 多 Bot 并存、话题线程各自独立会话
    const key = buildSessionKey({ kind: 'feishu', accountId, conversationId, threadId });
    console.log(`\n[收到] ${key}: ${text}`);
    feishu
      .sendMessage(conversationId, '…')
      .catch(() => {});
    const { text: reply } = await runTurn(session, text);
    await feishu.sendMessage(conversationId, reply || '（空回复）');
  });

  await feishu.connect();

  // mock 驱动器：模拟飞书群里两条消息
  const CHAT = 'oc_fake_chat_001';
  await feishu.simulateInbound(CHAT, '查一下 SKU-1002 的库存');
  await feishu.simulateInbound(CHAT, '把 SKU-1001 价格改成 299');

  await feishu.disconnect();
  session.dispose();
  console.log('\n[feishu-demo] 完成');
}
main().catch((e) => {
  console.error('失败:', e);
  process.exit(1);
});