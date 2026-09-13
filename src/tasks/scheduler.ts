/**
 * 定时任务调度器（单实例，R14 思想的单进程收窄）。
 *
 * 核心语义：
 *  - 双层数据模型：scheduled_tasks.next_run_at 兼任调度游标与乐观锁；
 *    task_runs.occurrence_key = taskId:scheduledFor 全局唯一——同一次触达至多一条运行。
 *  - 领取（claim）= 单事务内「游标比对 → INSERT OR IGNORE 物化 → 推进游标」：
 *    并发 tick 或重复触发被游标比对挡住，物化冲突被唯一约束挡住。
 *  - 错过策略：启动时扫 overdue——周期任务记 missed 并把游标推进到未来（不补跑，
 *    防补跑雪崩）；一次性任务保留 due（必达）。
 *  - 执行与领取解耦：事务只负责"这次触达归我"，Agent 执行在事务外异步进行，
 *    结果回写 task_runs 并投递到工作区对话。
 *  - 多实例租约 fencing（lease_token 单调递增 + 心跳续租）是多进程部署才需要的
 *    语义，单进程复现刻意不做。
 */
import crypto from 'node:crypto';
import type { Database as DatabaseType } from 'better-sqlite3';

// ── 频率模型（受控子集，不做全 cron 解析） ────────────────────────────

export type ScheduleSpec =
  | { type: 'interval'; minutes: number }
  | { type: 'daily'; hour: number; minute: number }
  | { type: 'once'; at: string };

export interface ScheduledTaskRow {
  id: string;
  workspace_id: string;
  name: string;
  prompt: string;
  schedule_json: string;
  enabled: number;
  next_run_at: string | null;
  last_run_at: string | null;
}

/** 校验并解析频率 JSON；非法抛错（中文错误信息直达 API） */
export function parseSchedule(json: string): ScheduleSpec {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('频率配置非法：不是合法 JSON');
  }
  const s = raw as ScheduleSpec;
  if (!s || typeof s !== 'object') throw new Error('频率配置非法');
  if (s.type === 'interval') {
    if (typeof s.minutes !== 'number' || !Number.isFinite(s.minutes) || s.minutes < 1 || s.minutes > 10_080) {
      throw new Error('间隔频率非法：minutes 需在 1~10080（7 天）之间');
    }
    return { type: 'interval', minutes: Math.floor(s.minutes) };
  }
  if (s.type === 'daily') {
    if (
      typeof s.hour !== 'number' || !Number.isInteger(s.hour) || s.hour < 0 || s.hour > 23 ||
      typeof s.minute !== 'number' || !Number.isInteger(s.minute) || s.minute < 0 || s.minute > 59
    ) {
      throw new Error('每日频率非法：hour 0-23、minute 0-59');
    }
    return { type: 'daily', hour: s.hour, minute: s.minute };
  }
  if (s.type === 'once') {
    if (typeof s.at !== 'string' || Number.isNaN(Date.parse(s.at))) {
      throw new Error('一次性频率非法：at 需为合法时间');
    }
    return { type: 'once', at: new Date(s.at).toISOString() };
  }
  throw new Error('频率类型非法：type 需为 interval / daily / once');
}

/** 从 from 之后（严格大于）的下一个触发时间；一次性任务返回其 at（调用方保证语义） */
export function nextRunFrom(spec: ScheduleSpec, from: Date): Date | null {
  if (spec.type === 'once') return new Date(spec.at);
  if (spec.type === 'interval') {
    return new Date(from.getTime() + spec.minutes * 60_000);
  }
  // daily：今天的 H:M 若已过则取明天
  const candidate = new Date(from);
  candidate.setHours(spec.hour, spec.minute, 0, 0);
  if (candidate.getTime() <= from.getTime()) candidate.setDate(candidate.getDate() + 1);
  return candidate;
}

/** 频率的人类描述（前端列表直接显示） */
export function describeSchedule(spec: ScheduleSpec): string {
  if (spec.type === 'interval') return `每 ${spec.minutes} 分钟`;
  if (spec.type === 'daily') return `每天 ${String(spec.hour).padStart(2, '0')}:${String(spec.minute).padStart(2, '0')}`;
  return `一次性 · ${spec.at.replace('T', ' ').slice(0, 16)}`;
}

// ── 调度器 ────────────────────────────────────────────────────────────

export interface SchedulerDeps {
  db: () => DatabaseType;
  /** 执行一轮 Agent（由调用方注入：含身份/工具/同工作区串行） */
  execute: (input: { workspaceId: string; prompt: string; sessionKey: string }) => Promise<string>;
}

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private deps: SchedulerDeps) {}

  start(intervalMs = 5_000): void {
    this.recoverOverdue();
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    this.timer.unref(); // 不阻塞进程退出（测试友好）
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 启动恢复：周期任务错过记 missed 推进游标；一次性保留 due（必达） */
  recoverOverdue(now = new Date()): number {
    const db = this.deps.db();
    const due = db
      .prepare("SELECT * FROM scheduled_tasks WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?")
      .all(now.toISOString()) as unknown as ScheduledTaskRow[];
    let marked = 0;
    for (const task of due) {
      let spec: ScheduleSpec;
      try {
        spec = parseSchedule(task.schedule_json);
      } catch {
        continue;
      }
      if (spec.type === 'once') continue; // 一次性必达，交给正常领取
      const claimed = this.claim(task, now, 'missed');
      if (claimed) marked++;
    }
    if (marked > 0) console.log(`[scheduler] 启动恢复：${marked} 个周期任务标记 missed（不补跑）`);
    return marked;
  }

  /** 一个调度 tick：领取全部 due 任务（领取≠执行，执行异步） */
  async tick(now = new Date()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const db = this.deps.db();
      const due = db
        .prepare("SELECT * FROM scheduled_tasks WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?")
        .all(now.toISOString()) as unknown as ScheduledTaskRow[];
      let claimedCount = 0;
      for (const task of due) {
        const claimed = this.claim(task, now, 'running');
        if (!claimed) continue;
        claimedCount++;
        // 事务外异步执行；结果回写 + 投递到工作区对话
        void this.execute(claimed.runId, task);
      }
      return claimedCount;
    } finally {
      this.running = false;
    }
  }

  /**
   * 领取一次触达：单事务「游标比对 → 物化 → 推进」。
   * 返回运行记录 id；被并发抢先/重复触发返回 null。
   */
  claim(
    task: ScheduledTaskRow,
    now: Date,
    initialStatus: 'running' | 'missed',
  ): { runId: string; snapshot: string } | null {
    const db = this.deps.db();
    let spec: ScheduleSpec;
    try {
      spec = parseSchedule(task.schedule_json);
    } catch {
      return null;
    }
    const runId = crypto.randomUUID();
    const snapshot = JSON.stringify({ name: task.name, prompt: task.prompt, schedule: spec });
    const occurrenceKey = `${task.id}:${task.next_run_at}`;

    const claimed = db.transaction((): boolean => {
      const cur = db
        .prepare('SELECT next_run_at, enabled FROM scheduled_tasks WHERE id = ?')
        .get(task.id) as { next_run_at: string | null; enabled: number } | undefined;
      // 乐观锁：游标已被推进（别的领取赢了）或已停用 → 放弃
      if (!cur || !cur.enabled || cur.next_run_at !== task.next_run_at) return false;
      // 幂等物化：同一次触达至多一条运行
      const info = db
        .prepare("INSERT OR IGNORE INTO task_runs (id, task_id, occurrence_key, status, snapshot) VALUES (?, ?, ?, ?, ?)")
        .run(runId, task.id, occurrenceKey, initialStatus, snapshot);
      if (info.changes === 0) return false;
      // 推进游标：周期取下一个时点；一次性完成使命（置空游标并停用）
      const next = spec.type === 'once' ? null : nextRunFrom(spec, now);
      db.prepare('UPDATE scheduled_tasks SET next_run_at = ?, last_run_at = datetime(\'now\') WHERE id = ?').run(
        next ? next.toISOString() : null,
        task.id,
      );
      if (spec.type === 'once') {
        db.prepare('UPDATE scheduled_tasks SET enabled = 0 WHERE id = ?').run(task.id);
      }
      return true;
    })();

    return claimed ? { runId, snapshot } : null;
  }

  /** 手动立即运行一次（演示/测试利器）：不动调度游标，物化独立的 manual 运行 */
  runNow(task: ScheduledTaskRow): string {
    const db = this.deps.db();
    const runId = crypto.randomUUID();
    const snapshot = JSON.stringify({
      name: task.name,
      prompt: task.prompt,
      schedule: parseSchedule(task.schedule_json),
    });
    db.prepare(
      "INSERT INTO task_runs (id, task_id, occurrence_key, status, snapshot) VALUES (?, ?, ?, 'running', ?)",
    ).run(runId, task.id, `${task.id}:manual-${crypto.randomUUID()}`, snapshot);
    void this.execute(runId, task);
    return runId;
  }

  /** 异步执行一轮并把结果投递到工作区对话 */
  private async execute(runId: string, task: ScheduledTaskRow): Promise<void> {
    const db = this.deps.db();
    const run = db.prepare('SELECT * FROM task_runs WHERE id = ?').get(runId) as
      | { id: string; snapshot: string; status: string }
      | undefined;
    if (!run || run.status !== 'running') return;
    let snap: { name: string; prompt: string };
    try {
      snap = JSON.parse(run.snapshot);
    } catch {
      snap = { name: task.name, prompt: task.prompt };
    }
    const sessionKey = buildTaskSessionKey(task.workspace_id);
    try {
      const result = await this.deps.execute({
        workspaceId: task.workspace_id,
        prompt: snap.prompt,
        sessionKey,
      });
      db.prepare("UPDATE task_runs SET status = 'succeeded', result_text = ?, finished_at = datetime('now') WHERE id = ?")
        .run(result, runId);
      appendResult(db, sessionKey, `⏰ 计划任务「${snap.name}」已完成`, result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      db.prepare("UPDATE task_runs SET status = 'failed', result_text = ?, finished_at = datetime('now') WHERE id = ?")
        .run(msg, runId);
      appendResult(db, sessionKey, `⏰ 计划任务「${snap.name}」失败`, msg);
    }
  }
}

/** 任务结果落在工作区主对话：打开对话就能看到定时产出 */
function buildTaskSessionKey(workspaceId: string): string {
  return `channel:web#account:${workspaceId}#conv:default`;
}

function appendResult(db: DatabaseType, sessionKey: string, title: string, body: string): void {
  db.prepare(
    'INSERT INTO chat_messages (id, session_key, role, content, meta) VALUES (?, ?, ?, ?, ?)',
  ).run(crypto.randomUUID(), sessionKey, 'system', `${title}\n${body}`, '{}');
}