/**
 * 工具验证入口：Agent 调用业务工具（query_pen_metrics / create_inspection_task），验证工具调用回传闭环。
 * 用法：tsx src/tool-demo.ts '查询 A3 猪舍今天的生产指标，并判断是否需要复检'
 */
import 'dotenv/config';
import { createPiRuntime, runTurn } from './agent-runtime.js';
import { allTools } from './tools.js';

async function main() {
  const prompt = process.argv.slice(2).join(' ') || '查询 A3 猪舍今天的生产指标，并判断是否需要复检';
  const { session } = await createPiRuntime({
    baseUrl: process.env.MINICLAW_BASE_URL!,
    apiKey: process.env.MINICLAW_API_KEY!,
    modelId: process.env.MINICLAW_MODEL!,
    providerId: 'custom',
    sessionName: 'tool',
    customTools: allTools,
    disableBuiltinTools: true,
  });
  try {
    const { text } = await runTurn(session, prompt);
    console.log('=== Agent 回答 ===');
    console.log(text.trim() || '(空回复)');
  } finally {
    session.dispose();
  }
}

main().catch((err) => {
  console.error('失败:', err);
  process.exit(1);
});
