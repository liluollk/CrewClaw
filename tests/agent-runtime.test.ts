/**
 * P1 · streamTurn 并发防护测试（BUG1 回归）。
 *
 * BUG1：重构时把 session.waitForIdle() 改成解绑调用，
 * waitForIdle 内部依赖 this → 抛 TypeError 被空 catch 吞掉 → 不等 idle 直接开流，
 * 恰好废掉"Agent is already processing"（踩坑 #6）的防护。
 *
 * 本测试用"依赖 this 的 waitForIdle"构造触发条件：
 *  - 修复后（bind）：waitForIdle 正常执行 → 顺序 [waitForIdle, prompt]
 *  - 修复前（解绑）：waitForIdle 抛错被吞 → 顺序只剩 [prompt]
 */
import { describe, expect, it } from 'vitest';
import { streamTurn } from '../src/agent-runtime.js';

describe('P1 · streamTurn idle 等待（BUG1 回归）', () => {
  it('waitForIdle 依赖 this 时必须被绑定调用，且 prompt 在 idle 之后才发起', async () => {
    const order: string[] = [];
    const session = {
      idle: true,
      subscribe(listener: (e: any) => void) {
        // 异步模拟 agent_end，让 onDone 触发以结束测试
        setTimeout(() => listener({ type: 'agent_end', sessionId: 's1', messages: [] }), 0);
        return () => {};
      },
      async prompt(_t: string) {
        order.push('prompt');
      },
      // 故意使用 this：解绑调用会抛 TypeError（BUG1 的触发条件）
      async waitForIdle(this: { idle: boolean }) {
        if (!this.idle) throw new Error('not idle');
        order.push('waitForIdle');
      },
    };

    await new Promise<void>((resolve) => {
      streamTurn(session as any, 'hi', {
        onDelta: () => {},
        onDone: () => resolve(),
      });
    });

    expect(order).toEqual(['waitForIdle', 'prompt']);
  });
});