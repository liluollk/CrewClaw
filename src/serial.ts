/**
 * 按 key 串行执行器：同一 key 的任务排成一条车道，跨 key 并行。
 * 用于"同一工作区的回合互不并发"——用户 SSE 对话、普通对话、定时任务
 * 共享同一条车道，避免并发 prompt 打爆同一个 Pi 会话。
 */
const queues = new Map<string, Promise<unknown>>();

export function runSerial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve();
  // prev.then(fn, fn)：无论上一个任务是成功还是失败，都执行本次 fn——
  // 前序失败不会让该 key 的车道永久卡死（坏消息不会阻塞后续任务）。
  // 注意副作用：调用方通过返回的 promise 感知自己的成败，感知不到前序任务的失败。
  const task = prev.then(fn, fn);
  queues.set(
    key,
    task.then(
      () => undefined,
      () => undefined,
    ),
  );
  return task;
}

/** 测试辅助：清空队列状态 */
export function clearSerialQueues(): void {
  queues.clear();
}
