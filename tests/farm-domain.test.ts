import { beforeEach, describe, expect, it } from 'vitest';
import {
  createInspectionTask,
  evaluateHealthRisk,
  listHealthObservations,
  queryPenMetrics,
  recordHealthObservation,
  resetFarmState,
} from '../src/farm-domain.js';

describe('养殖领域适配层', () => {
  beforeEach(() => resetFarmState());

  it('可以查询猪舍近期生产指标', () => {
    expect(queryPenMetrics('A3')).toMatchObject({
      penId: 'A3',
      feedIntakeKg: 182,
      coughCount: 8,
    });
  });

  it('采食量下降且咳嗽数量升高时给出关注风险', () => {
    const metrics = queryPenMetrics('A3');
    expect(metrics).toBeDefined();
    expect(evaluateHealthRisk(metrics!)).toMatchObject({ level: 'watch' });
  });

  it('可以记录异常观察并按猪舍查询', () => {
    recordHealthObservation({
      penId: 'A3',
      reporter: '饲养员-01',
      symptoms: '咳嗽',
      note: '今日发现多头猪咳嗽',
    });
    expect(listHealthObservations('A3')).toHaveLength(1);
  });

  it('可以创建复检任务并保留待办状态', () => {
    expect(createInspectionTask({
      penId: 'A3',
      assignee: '健康负责人',
      reason: '采食量下降且出现咳嗽',
    })).toMatchObject({
      penId: 'A3',
      status: 'open',
      assignee: '健康负责人',
    });
  });
});
