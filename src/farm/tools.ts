/**
 * 养殖场业务工具（内置模拟数据）。
 *
 * 设计要点：
 *  - 通过 Pi 的 customTools 注入业务能力，让 Agent 从"纯聊天"升级为"能干活"。
 *  - 工具层只做参数适配、审计和确认回路对接；领域数据与规则都在 src/farm-domain.ts。
 *  - 权限矩阵：指标/规范查询只读放行；异常观察记录自动执行并落审计；创建复检任务需用户确认。
 *  - 定位：验证 Agent 调用→权限门判定→确认回路执行的完整闭环，使用模拟猪场数据。
 */
import { Type } from 'typebox';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { decidePermissions } from '../permissions/permission.js';
import { permissionLoop } from '../permissions/permission-loop.js';
import { recordToolCall } from '../core/models.js';
import { getDatabase } from '../core/database.js';
import { turnContext } from '../core/runtime-context.js';
import {
  createInspectionTask,
  evaluateHealthRisk,
  queryPenMetrics,
  recordHealthObservation,
  searchOperationSops,
} from './farm-domain.js';

/** 查询猪舍生产指标：只读业务工具，附带可解释的风险提示（演示阈值，非诊断结论） */
export const queryPenMetricsTool = defineTool({
  name: 'query_pen_metrics',
  label: 'Query Pen Metrics',
  description: '按猪舍号查询近期生产指标（采食量、均重、咳嗽、腹泻、舍温），并给出可解释的风险提示。',
  parameters: Type.Object({
    penId: Type.String({ description: '猪舍编号，如 A3' }),
  }),
  async execute(_toolCallId, params) {
    const ctx = turnContext.getStore();
    const metrics = queryPenMetrics(params.penId);
    if (!metrics) {
      const text = `未找到猪舍 ${params.penId} 的指标数据`;
      recordToolCall(getDatabase(), {
        agentId: ctx?.agentId,
        workspaceId: ctx?.workspaceId,
        sessionKey: ctx?.sessionKey,
        actorUserId: ctx?.actorUserId,
        toolName: 'query_pen_metrics',
        input: params as Record<string, unknown>,
        status: 'error',
        resultText: text,
        triggerType: ctx?.triggerType,
      });
      return {
        content: [{ type: 'text', text }],
        details: { penId: params.penId, found: false },
      };
    }
    const risk = evaluateHealthRisk(metrics);
    const riskText = risk.reasons.length > 0 ? `，风险等级 ${risk.level}（${risk.reasons.join('；')}）` : `，风险等级 ${risk.level}`;
    const resultText = `${metrics.penId}（${metrics.areaId} / 批次 ${metrics.batchId}）：采食量 ${metrics.feedIntakeKg}kg（前一日 ${metrics.previousFeedIntakeKg}kg），均重 ${metrics.avgWeightKg}kg，咳嗽 ${metrics.coughCount} 头，腹泻 ${metrics.diarrheaCount} 头，舍温 ${metrics.temperatureC}°C${riskText}`;
    recordToolCall(getDatabase(), {
      agentId: ctx?.agentId,
      workspaceId: ctx?.workspaceId,
      sessionKey: ctx?.sessionKey,
      actorUserId: ctx?.actorUserId,
      toolName: 'query_pen_metrics',
      input: params as Record<string, unknown>,
      status: 'executed',
      resultText,
      triggerType: ctx?.triggerType,
    });
    return {
      content: [{ type: 'text', text: resultText }],
      details: { ...metrics, found: true, risk },
    };
  },
});

/** 查询养殖规范：只读业务工具 */
export const queryOperationSopTool = defineTool({
  name: 'query_operation_sop',
  label: 'Query Operation SOP',
  description: '按关键词检索养殖规范（健康管理、饲喂、环境控制、生物安全等 SOP）。',
  parameters: Type.Object({
    query: Type.String({ description: '关键词，空格分隔，如"咳嗽 上报"或"消毒"' }),
  }),
  async execute(_toolCallId, params) {
    const ctx = turnContext.getStore();
    const sops = searchOperationSops(params.query);
    const resultText = sops.length === 0
      ? `未找到与「${params.query}」相关的养殖规范`
      : sops.map((s) => `${s.id}《${s.title}》（${s.category}）：${s.content}`).join('\n');
    recordToolCall(getDatabase(), {
      agentId: ctx?.agentId,
      workspaceId: ctx?.workspaceId,
      sessionKey: ctx?.sessionKey,
      actorUserId: ctx?.actorUserId,
      toolName: 'query_operation_sop',
      input: params as Record<string, unknown>,
      status: 'executed',
      resultText,
      triggerType: ctx?.triggerType,
    });
    return {
      content: [{ type: 'text', text: resultText }],
      details: { query: params.query, count: sops.length, sops },
    };
  },
});

/** 记录异常观察：员工已明确上报的结果，自动执行并审计（不诊断、不开药） */
export const recordHealthObservationTool = defineTool({
  name: 'record_health_observation',
  label: 'Record Health Observation',
  description: '记录员工已经明确上报的猪舍异常观察（症状与备注）。只做记录，不做诊断或用药建议；自动执行并落审计。',
  parameters: Type.Object({
    penId: Type.String({ description: '猪舍编号，如 A3' }),
    symptoms: Type.String({ description: '员工上报的异常症状，如"咳嗽""腹泻"' }),
    note: Type.Optional(Type.String({ description: '补充说明' })),
    reporter: Type.Optional(Type.String({ description: '上报人，默认取当前对话成员' })),
  }),
  async execute(_toolCallId, params) {
    const ctx = turnContext.getStore();
    const observation = recordHealthObservation({
      penId: params.penId,
      symptoms: params.symptoms,
      note: params.note ?? '',
      reporter: params.reporter ?? ctx?.actorUserId ?? '群聊成员',
    });
    const resultText = `已记录 ${observation.penId} 的异常观察：${observation.symptoms}（上报人 ${observation.reporter}）`;
    recordToolCall(getDatabase(), {
      agentId: ctx?.agentId,
      workspaceId: ctx?.workspaceId,
      sessionKey: ctx?.sessionKey,
      actorUserId: ctx?.actorUserId,
      toolName: 'record_health_observation',
      input: params as Record<string, unknown>,
      status: 'executed',
      resultText,
      triggerType: ctx?.triggerType,
    });
    return {
      content: [{ type: 'text', text: resultText }],
      details: { observation, executed: true },
    };
  },
});

/** 复检任务核心动作：权限确认通过后由确认回路直接调用 */
async function doCreateInspectionTask(args: Record<string, unknown>): Promise<string> {
  const penId = String(args.penId ?? '');
  const assignee = String(args.assignee ?? '健康负责人');
  const reason = String(args.reason ?? '');
  const task = createInspectionTask({ penId, assignee, reason });
  const resultText = `已为 ${task.penId} 创建复检任务（负责人 ${task.assignee}）：${task.reason}`;
  recordToolCall(getDatabase(), {
    agentId: (args._agentId as string) ?? undefined,
    workspaceId: (args._workspaceId as string) ?? undefined,
    sessionKey: (args._sessionKey as string) ?? undefined,
    actorUserId: (args._actorUserId as string) ?? undefined,
    toolName: 'create_inspection_task',
    input: { penId, assignee, reason },
    status: 'executed',
    resultText,
    triggerType: (args._triggerType as string) ?? undefined,
  });
  return resultText;
}

/** 创建复检任务：写操作，权限门判定需用户确认 → 生成待确认请求，用户在界面点确认后执行 */
export const createInspectionTaskTool = defineTool({
  name: 'create_inspection_task',
  label: 'Create Inspection Task',
  description: '为猪舍创建复检任务。这是写操作，执行前需要负责人确认。',
  parameters: Type.Object({
    penId: Type.String({ description: '猪舍编号，如 A3' }),
    reason: Type.String({ description: '复检原因，如"采食量下降且出现咳嗽"' }),
    assignee: Type.Optional(Type.String({ description: '任务负责人，默认健康负责人' })),
  }),
  async execute(_toolCallId, params) {
    const ctx = turnContext.getStore();
    const decision = decidePermissions('create_inspection_task', params as Record<string, unknown>);
    if (decision.allowed && !decision.needsConfirmation) {
      const text = await doCreateInspectionTask({
        ...(params as Record<string, unknown>),
        _agentId: ctx?.agentId,
        _workspaceId: ctx?.workspaceId,
        _sessionKey: ctx?.sessionKey,
        _actorUserId: ctx?.actorUserId,
        _triggerType: ctx?.triggerType,
      });
      return {
        content: [{ type: 'text', text }],
        details: { ...params, executed: true },
      };
    }
    const summary = `为 ${params.penId} 创建复检任务：${params.reason}`;
    recordToolCall(getDatabase(), {
      agentId: ctx?.agentId,
      workspaceId: ctx?.workspaceId,
      sessionKey: ctx?.sessionKey,
      actorUserId: ctx?.actorUserId,
      toolName: 'create_inspection_task',
      input: params as Record<string, unknown>,
      status: 'pending',
      resultText: summary,
      triggerType: ctx?.triggerType,
    });
    const action = permissionLoop.request({
      tool: 'create_inspection_task',
      args: {
        ...(params as Record<string, unknown>),
        _agentId: ctx?.agentId,
        _workspaceId: ctx?.workspaceId,
        _sessionKey: ctx?.sessionKey,
        _actorUserId: ctx?.actorUserId,
        _triggerType: ctx?.triggerType,
      },
      summary,
    });
    return {
      content: [
        {
          type: 'text',
          text: `已向负责人发起确认请求：「${action.summary}」。用户确认后会直接执行；在确认前不要重复调用本工具，也不要口头创建任务。`,
        },
      ],
      details: { ...params, executed: false, confirmId: action.id },
    };
  },
});

permissionLoop.registerExecutor('create_inspection_task', doCreateInspectionTask);

/** 全部业务工具清单 */
export const allTools: ToolDefinition[] = [
  queryPenMetricsTool,
  queryOperationSopTool,
  recordHealthObservationTool,
  createInspectionTaskTool,
];
