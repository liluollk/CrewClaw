import 'dotenv/config';
import { createPiRuntime, runTurn } from './agent-runtime.js';

async function main() {
  const { session } = await createPiRuntime({
    baseUrl: process.env.MINICLAW_BASE_URL!,
    apiKey: process.env.MINICLAW_API_KEY!,
    modelId: process.env.MINICLAW_MODEL!,
    providerId: 'custom',
    sessionName: 'mem',
    customTools: [],
  });
  const send = async (t: string) => {
    const { text } = await runTurn(session, t);
    console.log(`>> ${t}\n<< ${text.trim()}\n`);
  };
  await send('记住：我的名字叫小明。只回复"记住了"。');
  await send('我叫什么名字？只要名字。');
  session.dispose();
}
main().catch((e) => { console.error('失败:', e); process.exit(1); });