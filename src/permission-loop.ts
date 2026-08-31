/**
 * 权限确认回路：写操作被权限门拦截时，生成一张"待确认"请求。
 *  - request()：工具侧调用，登记待办并广播 request 事件（SSE 转发为确认卡）。
 *  - confirm()：用户在界面点确认/取消后调用；确认时执行注册的执行器并返回结果文本。
 *  - 待办进程内存储 + 10 分钟 TTL（重启清空、超时作废）——刻意不做持久化：
 *    待确认动作属于瞬态，落库反而制造"重启后幽灵确认"。
 */
import { randomUUID } from 'node:crypto';
import { turnContext } from './runtime-context.js';

export interface PendingAction {
  id: string;
  tool: string;
  summary: string;
  args: Record<string, unknown>;
  sessionKey: string;
  /** 发起确认的工作区成员；共享工作区中允许其他成员继续审批，但要保留发起人。 */
  requestedBy?: string;
  createdAt: number;
}

type Executor = (args: Record<string, unknown>) => Promise<string> | string;

export type ConfirmOutcome =
  | { status: 'executed'; resultText: string }
  | { status: 'failed'; resultText: string }
  | { status: 'cancelled'; resultText: string }
  | { status: 'not_found'; resultText: string };

const TTL_MS = 10 * 60_000;

export class PermissionLoop {
  private pending = new Map<string, PendingAction & { executor: Executor }>();
  private listeners = new Set<(a: PendingAction) => void>();

  /** 当前回合的会话键：由服务端在发起一轮前设置（工具本身不知道自己跑在哪个会话里） */
  currentSessionKey = '';

  private executors = new Map<string, Executor>();

  /** 工具执行器登记：confirm(approve=true) 时按工具名调用 */
  registerExecutor(tool: string, fn: Executor): void {
    this.executors.set(tool, fn);
  }

  /** 发起确认请求；监听方（SSE/渠道）收到后向用户展示 */
  request(input: { tool: string; args: Record<string, unknown>; summary: string; sessionKey?: string }): PendingAction {
    this.sweep();
    const action: PendingAction & { executor: Executor } = {
      id: randomUUID(),
      tool: input.tool,
      summary: input.summary,
      args: input.args,
      // 归属优先取回合上下文（并发回合各自正确），退回进程级当前键
      sessionKey: input.sessionKey ?? turnContext.getStore()?.sessionKey ?? this.currentSessionKey,
      requestedBy: turnContext.getStore()?.actorUserId,
      createdAt: Date.now(),
      executor: this.executors.get(input.tool) ?? (() => `${input.tool} 没有登记执行器，无法执行`),
    };
    this.pending.set(action.id, action);
    for (const fn of this.listeners) {
      try {
        fn(action);
      } catch {
        /* 监听方异常不影响登记 */
      }
    }
    return action;
  }

  /**
   * 用户裁决。approve=true → 执行并返回结果文本。
   * expectedSessionKey：调用方工作区的会话键——不匹配按"不存在"返回（404 反枚举，
   * 不暴露该请求是否存在），且不删除待办（真正属主仍可裁决）。这是多用户下的归属闸门。
   */
  async confirm(id: string, approve: boolean, expectedSessionKey?: string): Promise<ConfirmOutcome> {
    this.sweep();
    const action = this.pending.get(id);
    if (!action) {
      return { status: 'not_found', resultText: '确认请求不存在或已过期' };
    }
    if (expectedSessionKey !== undefined && action.sessionKey !== expectedSessionKey) {
      return { status: 'not_found', resultText: '确认请求不存在或已过期' };
    }
    this.pending.delete(id);
    if (!approve) {
      return { status: 'cancelled', resultText: `已取消：${action.summary}` };
    }
    try {
      const resultText = await action.executor(action.args);
      return { status: 'executed', resultText };
    } catch (e) {
      // 执行失败：不销毁待办（交还调用方裁决是否重试），并如实上报 failed——
      // 用 executed 掩藏执行失败会造成审计与状态自相矛盾，且用户无从重试。
      this.pending.set(action.id, action);
      const msg = e instanceof Error ? e.message : String(e);
      return { status: 'failed', resultText: `执行失败：${msg}` };
    }
  }

  /** 收到确认请求时的回调（SSE 转发用）；返回解绑函数 */
  onRequest(fn: (a: PendingAction) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  pendingIds(): string[] {
    this.sweep();
    return [...this.pending.keys()];
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, a] of this.pending) {
      if (now - a.createdAt > TTL_MS) this.pending.delete(id);
    }
  }
}

export const permissionLoop = new PermissionLoop();
