/**
 * 养殖领域适配层（演示数据）。
 *
 * 定位：把"猪舍生产指标 / 异常观察 / 复检任务"的最小领域模型与查询写入函数
 * 收口在独立模块，工具层（src/tools.ts）只负责把它们暴露给 Agent Runtime，
 * 不直接操作领域状态。
 *
 * 数据边界：全部为进程内可重复初始化的模拟数据（resetFarmState），
 * 不接入真实猪场 ERP / MES / 物联网设备。
 */
import { randomUUID } from 'node:crypto';

export type RiskLevel = 'normal' | 'watch' | 'high';
export type TaskStatus = 'open' | 'done';

export interface PenMetrics {
  farmId: string;
  areaId: string;
  penId: string;
  batchId: string;
  measuredAt: string;
  feedIntakeKg: number;
  previousFeedIntakeKg: number;
  avgWeightKg: number;
  coughCount: number;
  diarrheaCount: number;
  temperatureC: number;
}

export interface HealthObservation {
  id: string;
  penId: string;
  reporter: string;
  symptoms: string;
  note: string;
  createdAt: string;
}

export interface InspectionTask {
  id: string;
  penId: string;
  assignee: string;
  reason: string;
  status: TaskStatus;
  createdAt: string;
}

export interface OperationSop {
  id: string;
  title: string;
  category: string;
  content: string;
}

/** 固定模拟夹具：A3 为异常对照舍（采食量下降 + 咳嗽），B1 为正常舍。 */
const INITIAL_PENS: PenMetrics[] = [
  {
    farmId: 'FARM-01',
    areaId: 'A区',
    penId: 'A3',
    batchId: 'B2026-09',
    measuredAt: '2026-09-13T08:00:00+08:00',
    feedIntakeKg: 182,
    previousFeedIntakeKg: 207,
    avgWeightKg: 78,
    coughCount: 8,
    diarrheaCount: 0,
    temperatureC: 25.5,
  },
  {
    farmId: 'FARM-01',
    areaId: 'B区',
    penId: 'B1',
    batchId: 'B2026-09',
    measuredAt: '2026-09-13T08:00:00+08:00',
    feedIntakeKg: 215,
    previousFeedIntakeKg: 212,
    avgWeightKg: 82,
    coughCount: 1,
    diarrheaCount: 0,
    temperatureC: 24.8,
  },
];

// 演示阈值：只用于演示"可解释的风险判断"，不是兽医诊断标准，不能用于真实用药或治疗决策。
const FEED_DROP_WATCH_PCT = 10; // 采食量较前一日下降超过 10% → 关注
const COUGH_WATCH_COUNT = 5; // 咳嗽数量大于 5 头 → 关注
const FEED_DROP_HIGH_PCT = 20; // 下降超过 20% → 高风险
const COUGH_HIGH_COUNT = 15; // 咳嗽数量大于 15 头 → 高风险

/** 养殖规范（SOP）模拟数据：通用饲养管理常识的简化摘录，仅用于演示检索闭环，不替代场内正式制度。 */
const OPERATION_SOPS: OperationSop[] = [
  {
    id: 'SOP-01',
    title: '呼吸道异常观察与上报',
    category: '健康管理',
    content: '发现猪只咳嗽、呼吸急促时，记录猪舍号、头数和出现时间，当日上报健康负责人；由兽医决定是否处置，饲养员不自行用药。',
  },
  {
    id: 'SOP-02',
    title: '每日采食量核查',
    category: '饲养管理',
    content: '每日固定时间记录各猪舍采食量，较前一日明显下降时复核饲喂设备和猪只状态，并把异常写入观察记录。',
  },
  {
    id: 'SOP-03',
    title: '猪舍通风与温度管理',
    category: '环境控制',
    content: '按批次和日龄设定目标温度与通风量，昼夜温差过大时优先调整通风，避免贼风直吹。',
  },
  {
    id: 'SOP-04',
    title: '生物安全消毒流程',
    category: '生物安全',
    content: '人员进出生产区按流程淋浴更衣，车辆入场冲洗消毒，工具与物资经转运窗传递并定期消毒。',
  },
];

let pens: PenMetrics[] = INITIAL_PENS.map((p) => ({ ...p }));
let observations: HealthObservation[] = [];
let tasks: InspectionTask[] = [];

/** 重置为初始模拟数据：测试隔离用，也可在演示脚本里重现初始现场。 */
export function resetFarmState(): void {
  pens = INITIAL_PENS.map((p) => ({ ...p }));
  observations = [];
  tasks = [];
}

export function queryPenMetrics(penId: string): PenMetrics | undefined {
  return pens.find((p) => p.penId === penId);
}

export function evaluateHealthRisk(metrics: PenMetrics): { level: RiskLevel; reasons: string[] } {
  const dropPct = ((metrics.previousFeedIntakeKg - metrics.feedIntakeKg) / metrics.previousFeedIntakeKg) * 100;
  const reasons: string[] = [];
  if (dropPct > FEED_DROP_WATCH_PCT) {
    reasons.push(`采食量较前一日下降 ${dropPct.toFixed(1)}%（演示阈值 ${FEED_DROP_WATCH_PCT}%）`);
  }
  if (metrics.coughCount > COUGH_WATCH_COUNT) {
    reasons.push(`咳嗽数量 ${metrics.coughCount} 头（演示阈值 ${COUGH_WATCH_COUNT} 头）`);
  }
  const severe = dropPct > FEED_DROP_HIGH_PCT || metrics.coughCount > COUGH_HIGH_COUNT;
  const level: RiskLevel = severe ? 'high' : reasons.length > 0 ? 'watch' : 'normal';
  return { level, reasons };
}

export function recordHealthObservation(input: Omit<HealthObservation, 'id' | 'createdAt'>): HealthObservation {
  const observation: HealthObservation = {
    ...input,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  observations.push(observation);
  return observation;
}

export function listHealthObservations(penId: string): HealthObservation[] {
  return observations.filter((o) => o.penId === penId);
}

export function createInspectionTask(input: Omit<InspectionTask, 'id' | 'createdAt' | 'status'>): InspectionTask {
  const task: InspectionTask = {
    ...input,
    id: randomUUID(),
    status: 'open',
    createdAt: new Date().toISOString(),
  };
  tasks.push(task);
  return task;
}

export function listInspectionTasks(penId?: string): InspectionTask[] {
  const matched = penId ? tasks.filter((t) => t.penId === penId) : tasks;
  return matched.map((t) => ({ ...t }));
}

/** 按关键词检索养殖规范：所有空格分隔的关键词都命中才算匹配，未给关键词时返回全部。 */
export function searchOperationSops(query: string): OperationSop[] {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return OPERATION_SOPS.map((s) => ({ ...s }));
  return OPERATION_SOPS.filter((sop) => {
    const haystack = `${sop.title} ${sop.category} ${sop.content}`;
    return terms.every((t) => haystack.includes(t));
  }).map((s) => ({ ...s }));
}
