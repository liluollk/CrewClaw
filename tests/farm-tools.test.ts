/**
 * 养殖业务工具测试：工具层行为（权限门 → 确认回路 → 审计底账 → 领域状态）。
 * 运行：npx vitest run tests/farm-tools.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import { initDatabase, resetDatabaseForTest, setDatabaseForTest } from '../src/database.js';
import {
  createInspectionTaskTool,
  queryOperationSopTool,
  queryPenMetricsTool,
  recordHealthObservationTool,
} from '../src/tools.js';
import { listHealthObservations, listInspectionTasks, resetFarmState } from '../src/farm-domain.js';
import { permissionLoop } from '../src/permission-loop.js';

describe('养殖业务工具', () => {
  let db: DatabaseType;

  beforeEach(() => {
    db = new Database(':memory:');
    initDatabase(db);
    setDatabaseForTest(db);
    resetFarmState();
  });

  afterEach(() => {
    resetDatabaseForTest();
  });

  function auditRows(toolName: string): Array<{ status: string; result_text: string }> {
    return db
      .prepare('SELECT status, result_text FROM tool_calls WHERE tool_name = ? ORDER BY created_at DESC')
      .all(toolName) as Array<{ status: string; result_text: string }>;
  }

  it('query_pen_metrics 返回 A3 指标和可解释风险提示', async () => {
    const res = await queryPenMetricsTool.execute('test-call', { penId: 'A3' });
    const text = res.content[0].type === 'text' ? res.content[0].text : '';
    expect(text).toContain('A3');
    expect(text).toContain('182');
    expect(text).toContain('watch');
    expect((res.details as { found: boolean }).found).toBe(true);
  });

  it('query_operation_sop 按关键词返回匹配规范', async () => {
    const res = await queryOperationSopTool.execute('test-call', { query: '咳嗽 上报' });
    const text = res.content[0].type === 'text' ? res.content[0].text : '';
    expect(text).toContain('呼吸道异常观察与上报');
    expect((res.details as { count: number }).count).toBe(1);
  });

  it('record_health_observation 写入领域状态并产生 executed 审计', async () => {
    const res = await recordHealthObservationTool.execute('test-call', {
      penId: 'A3',
      symptoms: '咳嗽',
      note: '多头猪咳嗽',
    });
    const text = res.content[0].type === 'text' ? res.content[0].text : '';
    expect(text).toContain('已记录 A3');
    expect(listHealthObservations('A3')).toHaveLength(1);
    const rows = auditRows('record_health_observation');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('executed');
  });

  it('create_inspection_task 首次调用产生待确认请求，不创建任务', async () => {
    const res = await createInspectionTaskTool.execute('test-call', {
      penId: 'A3',
      reason: '采食量下降且出现咳嗽',
    });
    const details = res.details as { executed: boolean; confirmId: string };
    expect(details.executed).toBe(false);
    expect(permissionLoop.pendingIds()).toContain(details.confirmId);
    expect(listInspectionTasks('A3')).toHaveLength(0);
    const rows = auditRows('create_inspection_task');
    expect(rows[0].status).toBe('pending');
  });

  it('确认执行器完成后任务变为 open 并落 executed 审计', async () => {
    const res = await createInspectionTaskTool.execute('test-call', {
      penId: 'A3',
      reason: '采食量下降且出现咳嗽',
      assignee: '健康负责人',
    });
    const confirmId = (res.details as { confirmId: string }).confirmId;
    const outcome = await permissionLoop.confirm(confirmId, true);
    expect(outcome.status).toBe('executed');
    expect(outcome.resultText).toContain('复检任务');
    const tasks = listInspectionTasks('A3');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ status: 'open', assignee: '健康负责人' });
    const rows = auditRows('create_inspection_task');
    expect(rows.map((r) => r.status)).toContain('executed');
  });
});
