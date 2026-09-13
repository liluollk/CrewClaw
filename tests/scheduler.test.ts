/**
 * 定时任务测试：频率模型、乐观锁领取、错过策略、任务 API（含手动运行）。
 * 执行经 AppOptions.executeTurn 注入假回合，不依赖真实 LLM。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { initDatabase, resetDatabaseForTest } from '../src/core/database.js';
import { createApp } from '../src/server.js';
import { createWorkspace } from '../src/core/models.js';
import { resetRateLimits } from '../src/core/auth.js';
import { runSerial, clearSerialQueues } from '../src/core/serial.js';
import {
  Scheduler,
  describeSchedule,
  nextRunFrom,
  parseSchedule,
  type ScheduledTaskRow,
} from '../src/tasks/scheduler.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时');
    await sleep(10);
  }
}

function createTempDb(): { db: DatabaseType; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniclaw-sched-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initDatabase(db);
  const cleanup = () => {
    db.close();
    for (const s of ['', '-wal', '-shm']) {
      try {
        fs.unlinkSync(dbPath + s);
      } catch {
        /* ignore */
      }
    }
    try {
      fs.rmdirSync(tmpDir);
    } catch {
      /* ignore */
    }
  };
  return { db, cleanup };
}

function seedTask(
  db: DatabaseType,
  overrides: Partial<{ id: string; schedule: string; next_run_at: string | null; enabled: number; prompt: string }> = {},
): ScheduledTaskRow {
  if (!db.prepare("SELECT 1 FROM workspaces WHERE id = 'ws-1'").get()) {
    createWorkspace(db, { id: 'ws-1', name: '空间', folder: 'ws1' });
  }
  const row = {
    id: overrides.id ?? 'task-1',
    workspace_id: 'ws-1',
    name: '日报',
    prompt: overrides.prompt ?? '汇总库存',
    schedule_json: overrides.schedule ?? '{"type":"interval","minutes":30}',
    enabled: overrides.enabled ?? 1,
    next_run_at: overrides.next_run_at ?? null,
    last_run_at: null,
  };
  db.prepare(
    "INSERT INTO scheduled_tasks (id, workspace_id, name, prompt, schedule_json, enabled, next_run_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(row.id, row.workspace_id, row.name, row.prompt, row.schedule_json, row.enabled, row.next_run_at);
  return row as unknown as ScheduledTaskRow;
}

// ── 频率模型 ──────────────────────────────────────────────────────────

describe('频率模型', () => {
  it('parseSchedule：非法输入全部拒绝', () => {
    expect(() => parseSchedule('not json')).toThrow();
    expect(() => parseSchedule('{"type":"cron","expr":"* * * * *"}')).toThrow(/类型非法/);
    expect(() => parseSchedule('{"type":"interval","minutes":0}')).toThrow(/minutes/);
    expect(() => parseSchedule('{"type":"interval","minutes":20000}')).toThrow(/minutes/);
    expect(() => parseSchedule('{"type":"daily","hour":24,"minute":0}')).toThrow(/hour/);
    expect(() => parseSchedule('{"type":"once","at":"not-a-date"}')).toThrow(/at/);
  });

  it('nextRunFrom：interval 顺延；daily 今天未到取今天、已过取明天；once 透传', () => {
    const from = new Date('2026-09-05T10:00:00');
    expect(nextRunFrom({ type: 'interval', minutes: 30 }, from)!.getTime()).toBe(
      new Date('2026-09-05T10:30:00').getTime(),
    );
    const dailyFuture = nextRunFrom({ type: 'daily', hour: 23, minute: 0 }, from)!;
    expect(dailyFuture.getDate()).toBe(5);
    const dailyPast = nextRunFrom({ type: 'daily', hour: 8, minute: 0 }, from)!;
    expect(dailyPast.getDate()).toBe(6);
    expect(nextRunFrom({ type: 'once', at: '2026-09-06T08:00:00Z' }, from)!.toISOString()).toBe(
      '2026-09-06T08:00:00.000Z',
    );
  });

  it('describeSchedule 人类可读', () => {
    expect(describeSchedule({ type: 'interval', minutes: 30 })).toBe('每 30 分钟');
    expect(describeSchedule({ type: 'daily', hour: 9, minute: 5 })).toBe('每天 09:05');
    expect(describeSchedule({ type: 'once', at: '2026-09-06T08:00:00Z' })).toContain('一次性');
  });
});

// ── 领取与执行 ────────────────────────────────────────────────────────

describe('调度器：领取/幂等/执行', () => {
  let db: DatabaseType;
  let cleanup: () => void;
  const executed: Array<{ workspaceId: string; prompt: string }> = [];

  beforeEach(() => {
    ({ db, cleanup } = createTempDb());
    executed.length = 0;
  });
  afterEach(() => {
    cleanup();
    resetDatabaseForTest();
  });

  function makeScheduler() {
    return new Scheduler({
      db: () => db,
      execute: async (input) => {
        executed.push(input);
        return `结果:${input.prompt}`;
      },
    });
  }

  it('tick：due 任务被领取执行，游标推进，结果回写 succeeded', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    seedTask(db, { next_run_at: past });
    const scheduler = makeScheduler();
    const claimed = await scheduler.tick();
    expect(claimed).toBe(1);
    await waitFor(() => executed.length === 1);
    expect(executed[0].prompt).toBe('汇总库存');

    const run = db.prepare('SELECT * FROM task_runs').get() as Record<string, unknown>;
    expect(run.status).toBe('succeeded');
    expect(run.result_text).toBe('结果:汇总库存');
    expect(String(run.occurrence_key)).toContain('task-1:');

    const task = db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get('task-1') as Record<string, unknown>;
    expect(new Date(task.next_run_at as string).getTime()).toBeGreaterThan(Date.now());
    await scheduler.stop();
  });

  it('重复领取：游标比对 + occurrence_key 唯一 双保险', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const task = seedTask(db, { next_run_at: past });
    const scheduler = makeScheduler();
    const first = scheduler.claim(task, new Date(), 'running');
    expect(first).not.toBeNull();
    // 同一陈旧游标再领 → 游标已被推进 → null
    expect(scheduler.claim(task, new Date(), 'running')).toBeNull();
    // 双 tick：第二次 tick 无可领
    expect(await scheduler.tick(new Date(Date.now() + 60_000))).toBe(0);
    expect((db.prepare('SELECT COUNT(*) c FROM task_runs').get() as { c: number }).c).toBe(1);
    await scheduler.stop();
  });

  it('错过策略：周期 overdue 记 missed 并推进；一次性保留必达、执行后停用', async () => {
    const overdue = new Date(Date.now() - 2 * 3600_000).toISOString();
    seedTask(db, { next_run_at: overdue }); // 周期
    seedTask(db, {
      id: 'task-2',
      prompt: '一次性提醒',
      schedule: `{"type":"once","at":"${overdue}"}`,
      next_run_at: overdue,
    }); // 一次性

    const scheduler = makeScheduler();
    const marked = scheduler.recoverOverdue();
    expect(marked).toBe(1); // 只有周期任务被标记

    const missed = db.prepare("SELECT * FROM task_runs WHERE status='missed'").get() as Record<string, unknown>;
    expect(missed).toBeTruthy();

    // 周期游标已被推进到未来
    const t1 = db.prepare("SELECT * FROM scheduled_tasks WHERE id='task-1'").get() as Record<string, unknown>;
    expect(new Date(t1.next_run_at as string).getTime()).toBeGreaterThan(Date.now());
    // 一次性保持 due → tick 必达执行 → 完成后停用 + 游标置空
    expect(await scheduler.tick()).toBe(1);
    await waitFor(() => executed.some((e) => e.prompt === '一次性提醒'));
    const t2 = db.prepare("SELECT * FROM scheduled_tasks WHERE id='task-2'").get() as Record<string, unknown>;
    expect(t2.enabled).toBe(0);
    expect(t2.next_run_at).toBeNull();
    await scheduler.stop();
  });
});

// ── 任务 API ──────────────────────────────────────────────────────────

describe('任务 API', () => {
  let db: DatabaseType;
  let cleanup: () => void;
  let auth: Awaited<ReturnType<typeof authedApp>>;

  let userSeq = 0;
  async function authedApp(d: DatabaseType, executeTurn: (i: { prompt: string }) => Promise<string>) {
    const app = createApp({
      db: d,
      executeTurn: async (input) => executeTurn(input),
    });
    const username = `sched${++userSeq}`;
    const reg = await app.fetch(
      new Request('http://localhost/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: 'password123' }),
      }),
    );
    const cookie = (reg.headers.get('Set-Cookie') ?? '').split(';')[0];
    const get = (p: string) => app.fetch(new Request('http://localhost' + p, { headers: { Cookie: cookie } }));
    const send = (p: string, method: string, body: unknown) =>
      app.fetch(
        new Request('http://localhost' + p, {
          method,
          headers: { Cookie: cookie, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
    return { app, get, send };
  }

  beforeEach(() => {
    ({ db, cleanup } = createTempDb());
    resetRateLimits();
  });
  afterEach(() => {
    cleanup();
    resetDatabaseForTest();
  });

  it('POST 校验：缺名称/非法频率 → 400', async () => {
    auth = await authedApp(db, async () => 'x');
    expect(
      (await auth.send('/api/tasks', 'POST', { name: '', prompt: 'p', schedule: { type: 'interval', minutes: 30 } })).status,
    ).toBe(400);
    expect(
      (await auth.send('/api/tasks', 'POST', { name: 'n', prompt: 'p', schedule: { type: 'cron' } })).status,
    ).toBe(400);
  });

  it('创建 → 列表可见；停用后游标清空', async () => {
    auth = await authedApp(db, async () => 'x');
    const created = await (await auth.send('/api/tasks', 'POST', {
      name: '每日汇总',
      prompt: '汇总库存',
      schedule: { type: 'daily', hour: 9, minute: 0 },
    })).json();
    expect(created.enabled).toBe(true);
    expect(created.nextRunAt).toBeTruthy();

    const list = (await (await auth.get('/api/tasks')).json()) as Array<{ scheduleText: string; name: string }>;
    expect(list).toHaveLength(1);
    expect(list[0].scheduleText).toBe('每天 09:00');

    const off = await (await auth.send(`/api/tasks/${created.id}`, 'PUT', { enabled: false })).json();
    expect(off.enabled).toBe(false);
    expect(off.nextRunAt).toBeNull();
  });

  it('手动运行：假回合执行 → 运行记录成功、结果落工作区对话', async () => {
    auth = await authedApp(db, async (input) => `已执行：${input.prompt}`);
    const created = await (await auth.send('/api/tasks', 'POST', {
      name: '巡检',
      prompt: '检查库存并给出建议',
      schedule: { type: 'interval', minutes: 60 },
    })).json();

    expect((await auth.send(`/api/tasks/${created.id}/run`, 'POST', {})).status).toBe(200);
    await waitFor(async () =>
      ((await (await auth.get(`/api/tasks/${created.id}/runs`)).json()) as Array<{ status: string }>).some(
        (r) => r.status === 'succeeded',
      ),
    );
    const runs = (await (await auth.get(`/api/tasks/${created.id}/runs`)).json()) as Array<{ resultText: string }>;
    expect(runs[0].resultText).toBe('已执行：检查库存并给出建议');
  });

  it('删除任务连运行记录一起清', async () => {
    auth = await authedApp(db, async () => 'x');
    const created = await (await auth.send('/api/tasks', 'POST', {
      name: 't',
      prompt: 'p',
      schedule: { type: 'interval', minutes: 10 },
    })).json();
    expect((await auth.send(`/api/tasks/${created.id}`, 'DELETE', {})).status).toBe(200);
    const list = (await (await auth.get('/api/tasks')).json()) as unknown[];
    expect(list).toHaveLength(0);
    expect(
      (db.prepare('SELECT COUNT(*) c FROM task_runs').get() as { c: number }).c,
    ).toBe(0);
  });
});

// ── 同工作区串行队列（BUG-3 回归） ────────────────────────────────────

describe('runSerial（同工作区车道）', () => {
  it('同 key 串行：并发三个只有一个在跑；不同 key 并行', async () => {
    const perKey: Record<string, number> = {};
    let maxSame = 0;
    let maxOther = 0;
    let maxAll = 0;
    let totalActive = 0;
    const task = (key: string) =>
      runSerial(key, async () => {
        perKey[key] = (perKey[key] ?? 0) + 1;
        totalActive++;
        maxAll = Math.max(maxAll, totalActive);
        if (key === 'same') maxSame = Math.max(maxSame, perKey[key]);
        else maxOther = Math.max(maxOther, perKey[key]);
        await sleep(15);
        perKey[key]--;
        totalActive--;
        return key;
      });
    await Promise.all([task('same'), task('same'), task('same'), task('other'), task('other')]);
    expect(maxSame).toBe(1); // 同 key 串行
    expect(maxOther).toBe(1);
    expect(maxAll).toBe(2); // 异 key 并行
    clearSerialQueues();
  });

  it('前一个任务失败不阻塞后续（车道自愈）', async () => {
    await expect(runSerial('k', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    const ok = await runSerial('k', async () => 'survived');
    expect(ok).toBe('survived');
    clearSerialQueues();
  });
});
