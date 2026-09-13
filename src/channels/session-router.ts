/**
 * 会话路由器：复合会话键 → 独立 Agent 会话。
 *
 * 设计要点：
 *  - 每个会话键（渠道+账号+对话+话题）一个独立 Pi 会话目录，互不污染——
 *    "各群各会话、多 Bot 不串扰"在运行时成立，而不只是键代数成立。
 *  - 同键请求串行执行（队列链）：同一群两条消息连续到达不会并发 prompt
 *    同一个 session（Pi 会报 already processing）。
 *  - 身份变更 → clear() 释放全部会话，下一回合用新身份重建。
 */
import type { AgentSessionHandle } from '../agent/agent-runtime.js';

type SessionLike = AgentSessionHandle['session'];

export class SessionRouter {
  private sessions = new Map<string, Promise<AgentSessionHandle>>();
  private queues = new Map<string, Promise<unknown>>();

  constructor(private factory: (sessionName: string) => Promise<AgentSessionHandle>) {}

  /** 复合键 → 安全目录名（冒号/井号/空格折叠为下划线，限长防路径问题） */
  static sessionNameFor(key: string): string {
    const safe = key.replace(/[^a-zA-Z0-9._-]+/g, '_');
    return `ch-${safe.slice(0, 80)}`;
  }

  /** 取（或懒建）该键的会话 */
  get(key: string): Promise<AgentSessionHandle> {
    let p = this.sessions.get(key);
    if (!p) {
      p = this.factory(SessionRouter.sessionNameFor(key));
      // 建失败时移除缓存，允许下次重试
      p.catch(() => this.sessions.delete(key));
      this.sessions.set(key, p);
    }
    return p;
  }

  /** 在该键的会话上串行执行一轮 */
  run<T>(key: string, fn: (session: SessionLike) => Promise<T>): Promise<T> {
    const prev = this.queues.get(key) ?? Promise.resolve();
    const task = prev.then(() => this.get(key)).then((h) => fn(h.session));
    // 队列只记录"完成"信号，失败不阻塞后续请求
    this.queues.set(
      key,
      task.then(
        () => undefined,
        () => undefined,
      ),
    );
    return task;
  }

  /** 释放全部会话（身份变更后调用；下次 get 重建） */
  async clear(): Promise<void> {
    const all = [...this.sessions.values()];
    this.sessions.clear();
    this.queues.clear();
    for (const p of all) {
      try {
        (await p).dispose();
      } catch {
        /* ignore */
      }
    }
  }

  keys(): string[] {
    return [...this.sessions.keys()];
  }

  size(): number {
    return this.sessions.size;
  }
}