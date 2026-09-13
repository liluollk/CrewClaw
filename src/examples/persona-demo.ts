/**
 * 集成验证 · 身份闭环：
 *   创建 Profile（四段身份）→ buildPersonaPrompt 拼装 → 注入 Pi → 对话按身份作答
 *   → 修改身份 → identity_hash 变化 + version+1 → 重新装配 → 新回合按新身份作答。
 *
 * 运行：npm run persona-demo   （需要 .env 的 MINICLAW_BASE_URL/KEY/MODEL）
 */
import 'dotenv/config';
import { getDatabase } from '../core/database.js';
import { createAgentProfile, updateAgentProfile, getAgentProfile } from '../core/models.js';
import { buildPersonaPrompt } from '../agent/persona.js';
import { createPiRuntime, runTurn } from '../agent/agent-runtime.js';

const ID = 'persona-demo-agent';

async function chat(systemPrompt: string, text: string): Promise<string> {
  const { session } = await createPiRuntime({
    baseUrl: process.env.MINICLAW_BASE_URL!,
    apiKey: process.env.MINICLAW_API_KEY!,
    modelId: process.env.MINICLAW_MODEL!,
    providerId: 'custom',
    sessionName: 'persona',
    systemPrompt,
  });
  try {
    const { text: reply } = await runTurn(session, text);
    return reply;
  } finally {
    (session as unknown as { dispose?: () => void }).dispose?.();
  }
}

async function main() {
  const db = getDatabase();

  // 1) 创建带海盗猫身份的 Profile（幂等：已存在则复用）
  if (!getAgentProfile(db, ID)) {
    createAgentProfile(db, {
      id: ID,
      name: '海盗猫',
      identityPrompt: '你是一只自称"本喵"的海盗猫 Agent，性格豪迈。',
      agentsPrompt: '每次回答不超过两句话，句尾必须带"呀哈"。',
    });
  }

  const p1 = buildPersonaPrompt(db, ID);
  console.log(`[身份 v${p1.version}] planHash=${p1.planHash.slice(0, 12)}… tokens≈${p1.estimatedTokens}`);
  console.log('Q: 你好，你是谁？');
  console.log('A:', await chat(p1.fullPrompt, '你好，你是谁？'), '\n');

  // 2) 改身份（优雅学者）→ 观察 identity_hash 与 version 变化
  updateAgentProfile(db, ID, {
    identityPrompt: '你是一位自称"在下"的优雅学者猫 Agent，谈吐文雅。',
    agentsPrompt: '每次回答不超过两句话，句尾必须带"喵呜"。',
  });
  const p2 = buildPersonaPrompt(db, ID);
  console.log(`[身份 v${p2.version}] planHash=${p2.planHash.slice(0, 12)}… tokens≈${p2.estimatedTokens}`);
  console.log(`hash 变化: ${p1.identityHash !== p2.identityHash} | version 递增: ${p1.version}→${p2.version}`);
  console.log('Q: 你好，你是谁？');
  console.log('A:', await chat(p2.fullPrompt, '你好，你是谁？'));
}

main().catch((e) => {
  console.error('失败:', e);
  process.exit(1);
});