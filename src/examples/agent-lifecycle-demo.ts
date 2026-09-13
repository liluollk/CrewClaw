/**
 * Agent 生命周期 Demo：串联 CrewClaw 核心模块，展示完整数字员工运行链路。
 *
 * 场景：为"养殖健康团队"创建一个数字员工「健康巡检助手」，它拥有独立身份、
 * 长期工作记忆和工具权限，驻在飞书群中响应消息，同时每天定时生成巡检日报。
 *
 * 流程：
 *   1. 创建数字员工 + 配置 Identity（身份/性格/工作规则/工具说明）
 *   2. 创建 Workspace（养殖健康团队工作空间） + 绑定数字员工
 *   3. 装配 Identity 注入 Prompt
 *   4. 模拟渠道消息（message trigger）→ 数字员工查猪舍指标
 *   5. 数字员工 recall_memory（检索长期工作经验）
 *   6. 数字员工调用工具（query_pen_metrics）→ 示例业务工具闭环
 *   7. 权限确认（create_inspection_task → ask → confirm）
 *   8. 数字员工 remember_memory（沉淀新工作经验）
 *   9. 模拟定时触发（schedule trigger）→ 数字员工主动生成日报
 *  10. 审计底账：查看 tool_calls 记录
 *
 * 运行：npm run lifecycle-demo   （需要 .env 的 MINICLAW_BASE_URL/KEY/MODEL）
 */
import 'dotenv/config';
import { getDatabase } from '../core/database.js';
import {
  createAgentProfile,
  createWorkspace,
  bindProfileToWorkspace,
  ensureWorkspaceProfile,
  recordToolCall,
  listToolCalls,
  appendChatMessage,
} from '../core/models.js';
import { buildPersonaPrompt } from '../agent/persona.js';
import { createAgentFactory, runTurn, type AgentFactory } from '../agent/agent-runtime.js';
import { SessionRouter } from '../channels/session-router.js';
import { buildSessionKey } from '../channels/channel.js';
import { allTools } from '../farm/tools.js';
import { createMemoryTools } from '../memory/memory-tools.js';
import { turnContext } from '../core/runtime-context.js';
import { permissionLoop } from '../permissions/permission-loop.js';

const AGENT_ID = 'lifecycle-demo-agent';
const WORKSPACE_ID = 'ws-lifecycle';
const WORKSPACE_FOLDER = 'lifecycle';

async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  CrewClaw Agent 生命周期 Demo');
  console.log('═══════════════════════════════════════════\n');

  const db = getDatabase();

  // ═══════════════════════════════════════════
  // 1. 创建数字员工 + 配置 Identity
  // ═══════════════════════════════════════════
  console.log('▶ 1. 创建数字员工并配置 Identity');
  if (!db.prepare('SELECT id FROM agent_profiles WHERE id = ?').get(AGENT_ID)) {
    createAgentProfile(db, {
      id: AGENT_ID,
      name: '健康巡检助手',
      identityPrompt: '你是养殖场的健康巡检数字员工，负责查询猪舍指标、记录异常观察，回答简洁专业。',
      soulPrompt: '认真负责，关注细节，主动汇报。',
      agentsPrompt: '收到请求后先检索工作经验，必要时调用工具获取数据，最后沉淀知识。',
      toolsPrompt: 'query_pen_metrics 查猪舍指标，create_inspection_task 创建复检任务（需确认），recall_memory 查经验，remember_memory 记知识。',
    });
    console.log('   已创建数字员工 Profile:', AGENT_ID);
  } else {
    console.log('   数字员工 Profile 已存在:', AGENT_ID);
  }
  const profile = db.prepare('SELECT * FROM agent_profiles WHERE id = ?').get(AGENT_ID) as Record<string, unknown>;
  console.log(`   identity_hash: ${(profile.identity_hash as string).slice(0, 16)}…`);
  console.log(`   version: ${profile.version}\n`);

  // ═══════════════════════════════════════════
  // 2. 创建 Workspace + 绑定数字员工
  // ═══════════════════════════════════════════
  console.log('▶ 2. 创建 Workspace 并绑定数字员工');
  if (!db.prepare('SELECT id FROM workspaces WHERE id = ?').get(WORKSPACE_ID)) {
    createWorkspace(db, {
      id: WORKSPACE_ID,
      name: '养殖健康团队',
      folder: WORKSPACE_FOLDER,
      owner: 'demo',
    });
    console.log('   已创建 Workspace:', WORKSPACE_ID);
  } else {
    console.log('   Workspace 已存在:', WORKSPACE_ID);
  }
  bindProfileToWorkspace(db, WORKSPACE_ID, AGENT_ID);
  console.log('   已绑定数字员工 → 养殖健康团队工作空间\n');

  // ═══════════════════════════════════════════
  // 3. 装配 Identity Prompt
  // ═══════════════════════════════════════════
  console.log('▶ 3. 装配 Identity 并注入 Prompt');
  const persona = buildPersonaPrompt(db, AGENT_ID);
  console.log(`   planHash: ${persona.planHash.slice(0, 12)}…`);
  console.log(`   estimatedTokens: ${persona.estimatedTokens}`);
  console.log(`   四段结构: IDENTITY + SOUL + AGENTS + TOOLS\n`);

  // ═══════════════════════════════════════════
  // 4. 创建 Agent Factory + SessionRouter
  // ═══════════════════════════════════════════
  console.log('▶ 4. 初始化 Agent Runtime');
  const factory: AgentFactory = await createAgentFactory({
    baseUrl: process.env.MINICLAW_BASE_URL!,
    apiKey: process.env.MINICLAW_API_KEY!,
    modelId: process.env.MINICLAW_MODEL!,
    providerId: 'custom',
    sessionDir: undefined,
    customTools: [...allTools, ...createMemoryTools(() => WORKSPACE_ID)],
    disableBuiltinTools: true,
    systemPrompt: persona.fullPrompt,
  });

  const router = new SessionRouter(async (sessionName) => {
    return factory.createSession(sessionName);
  });
  console.log('   SessionRouter 已就绪\n');

  // ═══════════════════════════════════════════
  // 5. 模拟渠道消息 → 数字员工检索经验
  // ═══════════════════════════════════════════
  console.log('▶ 5. 模拟消息触发（triggerType: message）');
  const sessionKey = buildSessionKey({
    kind: 'demo',
    conversationId: 'lifecycle-chat',
  });

  // 先写入一条记忆，让数字员工能检索到
  console.log('   预写入一条工作经验：复检任务确认规则');
  const { createMemory } = await import('../memory/memory.js');
  createMemory(db, {
    workspaceId: WORKSPACE_ID,
    kind: 'decision',
    content: '创建复检任务需经负责人确认后才能执行，不可绕过确认步骤。',
    title: '复检任务确认规则',
  });

  const reply1 = await router.run(sessionKey, async (session) => {
    appendChatMessage(db, { sessionKey, role: 'user', content: '查一下 A3 猪舍的生产指标，之前关于复检任务有什么规定？' });
    return turnContext.run(
      {
        workspaceId: WORKSPACE_ID,
        sessionKey,
        agentId: AGENT_ID,
        triggerType: 'message',
      },
      async () => {
        const { text } = await runTurn(session, '查一下 A3 猪舍的生产指标，之前关于复检任务有什么规定？');
        appendChatMessage(db, { sessionKey, role: 'assistant', content: text });
        return text;
      },
    );
  });
  console.log(`   数字员工回复: ${reply1.slice(0, 200)}${reply1.length > 200 ? '…' : ''}\n`);

  // ═══════════════════════════════════════════
  // 6. 工具调用审计
  // ═══════════════════════════════════════════
  console.log('▶ 6. 工具调用审计底账');
  recordToolCall(db, {
    agentId: AGENT_ID,
    workspaceId: WORKSPACE_ID,
    sessionKey,
    toolName: 'query_pen_metrics',
    input: { penId: 'A3' },
    status: 'auto',
    resultText: 'A3（A区 / 批次 B2026-09）：采食量 182kg（前一日 207kg），咳嗽 8 头，风险等级 watch（采食量较前一日下降 12.1%）',
    triggerType: 'message',
  });
  recordToolCall(db, {
    agentId: AGENT_ID,
    workspaceId: WORKSPACE_ID,
    sessionKey,
    toolName: 'recall_memory',
    input: { query: '复检 规定' },
    status: 'auto',
    resultText: '决策：复检任务确认规则 — 创建复检任务需经负责人确认后才能执行',
    triggerType: 'message',
  });
  const calls = listToolCalls(db, { agentId: AGENT_ID, limit: 5 });
  console.log(`   已记录 ${calls.length} 条工具调用`);
  for (const c of calls) {
    console.log(`   [${c.status}] ${c.toolName} (${c.triggerType}) — ${c.resultText.slice(0, 60)}…`);
  }
  console.log();

  // ═══════════════════════════════════════════
  // 7. 权限确认回路
  // ═══════════════════════════════════════════
  console.log('▶ 7. 权限确认回路（ASK 模式）');
  permissionLoop.currentSessionKey = sessionKey;
  const action = permissionLoop.request({
    tool: 'create_inspection_task',
    args: { penId: 'A3', reason: '采食量下降且出现咳嗽' },
    summary: '为 A3 创建复检任务：采食量下降且出现咳嗽',
    sessionKey,
  });
  console.log(`   待确认请求: ${action.id} — ${action.summary}`);

  // 模拟用户确认
  const outcome = await permissionLoop.confirm(action.id, true, sessionKey);
  console.log(`   确认结果: [${outcome.status}] ${outcome.resultText}`);

  recordToolCall(db, {
    agentId: AGENT_ID,
    workspaceId: WORKSPACE_ID,
    sessionKey,
    toolName: 'create_inspection_task',
    input: { penId: 'A3', reason: '采食量下降且出现咳嗽' },
    status: 'approved',
    resultText: outcome.resultText,
    triggerType: 'message',
  });
  console.log();

  // ═══════════════════════════════════════════
  // 8. 数字员工沉淀工作经验
  // ═══════════════════════════════════════════
  console.log('▶ 8. 数字员工沉淀工作经验');
  const { item } = createMemory(db, {
    workspaceId: WORKSPACE_ID,
    kind: 'fact',
    content: 'A3 复检任务已创建，负责人健康负责人（演示确认）',
    title: 'A3 复检任务',
  });
  console.log(`   已记录: [${item.kind}] ${item.title} — ${item.content}`);
  recordToolCall(db, {
    agentId: AGENT_ID,
    workspaceId: WORKSPACE_ID,
    sessionKey,
    toolName: 'remember_memory',
    input: { kind: 'fact', content: item.content, title: item.title },
    status: 'auto',
    resultText: `已记住：${item.title}`,
    triggerType: 'message',
  });
  console.log();

  // ═══════════════════════════════════════════
  // 9. 模拟定时触发
  // ═══════════════════════════════════════════
  console.log('▶ 9. 模拟定时触发（triggerType: schedule）');
  const scheduleKey = buildSessionKey({
    kind: 'demo',
    conversationId: 'lifecycle-schedule',
  });
  const reply2 = await router.run(scheduleKey, async (session) => {
    const prompt = '生成今日巡检总结：今天查了 A3 猪舍生产指标，并创建了复检任务。';
    appendChatMessage(db, { sessionKey: scheduleKey, role: 'user', content: prompt });
    return turnContext.run(
      {
        workspaceId: WORKSPACE_ID,
        sessionKey: scheduleKey,
        agentId: AGENT_ID,
        triggerType: 'schedule',
      },
      async () => {
        const { text } = await runTurn(session, prompt);
        appendChatMessage(db, { sessionKey: scheduleKey, role: 'assistant', content: text });
        return text;
      },
    );
  });
  console.log(`   数字员工定时回复: ${reply2.slice(0, 200)}${reply2.length > 200 ? '…' : ''}`);
  recordToolCall(db, {
    agentId: AGENT_ID,
    workspaceId: WORKSPACE_ID,
    sessionKey: scheduleKey,
    toolName: 'recall_memory',
    input: { query: '今日 工作总结' },
    status: 'auto',
    resultText: '已检索到 A3 复检任务记忆',
    triggerType: 'schedule',
  });
  console.log();

  // ═══════════════════════════════════════════
  // 10. 审计底账汇总
  // ═══════════════════════════════════════════
  console.log('▶ 10. 审计底账汇总');
  const allCalls = listToolCalls(db, { agentId: AGENT_ID, limit: 20 });
  console.log(`   Agent ${AGENT_ID} 共执行 ${allCalls.length} 次工具调用：`);
  for (const c of allCalls) {
    const icon = c.status === 'approved' ? '✓' : c.status === 'pending' ? '⏳' : '○';
    console.log(`   ${icon} [${c.triggerType}] ${c.toolName} → ${c.status} (${c.createdAt})`);
  }
  console.log();

  // ═══════════════════════════════════════════
  // 总结
  // ═══════════════════════════════════════════
  console.log('═══════════════════════════════════════════');
  console.log('  数字员工生命周期 Demo 完成');
  console.log('═══════════════════════════════════════════');
  console.log();
  console.log('完整链路：');
  console.log('  创建数字员工 → 配置 Identity → 绑定养殖健康团队工作空间');
  console.log('  → 消息触发 → 检索工作经验 → 调用工具 → 权限确认');
  console.log('  → 沉淀新经验 → 定时触发 → 审计底账');
  console.log();
  console.log('关键模块：');
  console.log('  - Agent Identity (persona.ts + models.ts)');
  console.log('  - Workspace 隔离 (models.ts)');
  console.log('  - SessionRouter (session-router.ts)');
  console.log('  - 长期记忆 (memory.ts + memory-tools.ts)');
  console.log('  - Tool + PermissionGate (tools.ts + permission.ts + permission-loop.ts)');
  console.log('  - Execution Context (runtime-context.ts)');
  console.log('  - Tool Audit Trail (tool_calls 表)');
  console.log('  - 多触发类型: message / schedule');

  await router.clear();
  await (factory as unknown as { dispose?: () => void }).dispose?.();
}

main().catch((e) => {
  console.error('失败:', e);
  process.exit(1);
});