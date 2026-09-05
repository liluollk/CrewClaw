/**
 * 最小验证入口：进程内直调 Pi，跑通一句。
 * 现改用 src/agent-runtime.ts 的 createPiRuntime（动态注册 provider + env key 注入）。
 */
import 'dotenv/config';
import { createPiRuntime, runTurn } from './agent-runtime.js';

async function main() {
  const { session } = await createPiRuntime({
    baseUrl: process.env.MINICLAW_BASE_URL!,
    apiKey: process.env.MINICLAW_API_KEY!,
    modelId: process.env.MINICLAW_MODEL!,
    providerId: 'custom',
    sessionName: 'hello',
  });
  try {
    const { text } = await runTurn(session, '1 + 1 = ? 只回答数字。');
    console.log('=== Pi 回答 ===');
    console.log(text.trim() || '(空回复)');
  } finally {
    session.dispose();
  }
}

main().catch((err) => {
  console.error('Hello 失败:', err);
  process.exit(1);
});