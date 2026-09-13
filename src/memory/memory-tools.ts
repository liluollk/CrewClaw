/**
 * 记忆工具：把长期记忆接进 Agent 的工具面。
 *  - recall_memory：回答前检索用户教过的知识（FTS/LIKE 同一套检索）。
 *  - remember_memory：用户说"记住…"时由 Agent 写入，Web 记忆页立即可见。
 * 写路径走 createMemory（类型校验 + 幂等），不绕过管线。
 */
import { Type } from 'typebox';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { createMemory, searchMemory, type MemoryKind, type MemoryScope } from './memory.js';
import { getDatabase } from '../core/database.js';
import { turnContext } from '../core/runtime-context.js';

const KIND_LABEL: Record<MemoryKind, string> = {
  fact: '事实',
  decision: '决策',
  lesson: '经验',
  open_loop: '待办',
};

/**
 * 创建记忆工具。
 * @param defaultWorkspaceId 兜底工作区；回合内有 ALS 上下文时优先用上下文的
 *        （Web 与多工作区网关共用同一套工具，归属随回合走）。
 */
export function createMemoryTools(
  defaultWorkspaceId: string | (() => string | undefined),
): ToolDefinition[] {
  const resolveWorkspace = (): string => {
    const fromCtx = turnContext.getStore()?.workspaceId;
    if (fromCtx) return fromCtx;
    return typeof defaultWorkspaceId === 'string' ? defaultWorkspaceId : defaultWorkspaceId() ?? '';
  };

  const recall = defineTool({
    name: 'recall_memory',
    label: 'Recall Memory',
    description:
      '查询你的长期记忆（用户教过的事实/决策/经验/待办）。当用户的问题可能与这些既有约定或知识相关时，先调用本工具再回答。',
    parameters: Type.Object({
      query: Type.String({ description: '搜索关键词，如"改价"' }),
      limit: Type.Optional(Type.Number({ description: '最多返回几条，默认 5' })),
    }),
    async execute(_toolCallId, params) {
      const sessionKey = turnContext.getStore()?.sessionKey;
      const items = searchMemory(getDatabase(), {
        workspaceId: resolveWorkspace(),
        query: params.query,
        limit: Math.min(params.limit ?? 5, 20),
        sessionKey,
      });
      if (items.length === 0) {
        return { content: [{ type: 'text', text: '（没有相关记忆）' }] };
      }
      const text = items
        .map((i) => `【${KIND_LABEL[i.kind]}】${i.title ? `${i.title}：` : ''}${i.content}`)
        .join('\n');
      return { content: [{ type: 'text', text }] };
    },
  });

  const remember = defineTool({
    name: 'remember_memory',
    label: 'Remember Memory',
    description:
      '把需要长期保留的信息写入记忆（用户明确说"记住…"，或对话中形成的重要约定）。kind 取值：fact=事实、decision=决策、lesson=经验、open_loop=待办。',
    parameters: Type.Object({
      kind: Type.String({ description: 'fact | decision | lesson | open_loop' }),
      content: Type.String({ description: '要记住的内容，一句话写清楚' }),
      title: Type.Optional(Type.String({ description: '短标题（可选）' })),
      importance: Type.Optional(Type.Number({ description: '重要程度 0~1，默认 0.5' })),
      scope: Type.Optional(Type.String({ description: 'workspace=团队共享；conversation=当前会话，默认当前会话' })),
    }),
    async execute(_toolCallId, params) {
      try {
        const ctx = turnContext.getStore();
        const scope = (params.scope as MemoryScope | undefined) ?? (ctx?.sessionKey ? 'conversation' : 'workspace');
        if (scope === 'workspace' && ctx && ctx.workspaceRole === 'member') {
          throw new Error('普通成员默认只能写当前会话记忆，团队共享记忆需管理员确认');
        }
        const { item } = createMemory(getDatabase(), {
          workspaceId: resolveWorkspace(),
          kind: params.kind as MemoryKind,
          content: params.content,
          title: params.title,
          importance: params.importance,
          scope,
          scopeKey: scope === 'conversation' ? ctx?.sessionKey : undefined,
        });
        return {
          content: [
            { type: 'text', text: `已记住（${KIND_LABEL[item.kind]}，重要度 ${item.importance}）：${item.content}` },
          ],
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: 'text', text: `记住失败：${msg}` }] };
      }
    },
  });

  return [recall, remember];
}
