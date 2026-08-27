/**
 * 回合级 Agent 执行上下文（AsyncLocalStorage）。
 *
 * 一轮对话或定时触发开始时写入完整上下文，回合内执行的工具（记忆读写、权限确认、
 * 工具审计）从上下文取归属——不同工作区/不同 Agent 的并发回合互不串。
 *
 * 设计要点：
 *  - workspaceId + sessionKey：归属与隔离（已有）
 *  - agentId：审计追踪——"哪个 Agent 做了什么"
 *  - actorUserId：成员审计——"哪个团队成员触发了这轮 Agent 行为"
 *  - triggerType："message" | "schedule" | "manual"——区分唤醒来源
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export type TriggerType = 'message' | 'schedule' | 'manual';

export interface TurnContext {
  workspaceId?: string;
  sessionKey?: string;
  agentId?: string;
  actorUserId?: string;
  workspaceRole?: 'owner' | 'admin' | 'member';
  triggerType?: TriggerType;
}

export const turnContext = new AsyncLocalStorage<TurnContext>();
