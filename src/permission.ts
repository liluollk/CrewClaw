/**
 * 权限门（PermissionGate）：无旁路的工具级权限判定。
 *
 * 设计要点（无 Admin 旁路 + ask 确认模式）：
 *  - 工具声明 mode：readonly（直接放行）/ ask（需确认）/ execute（自动执行）。
 *  - 判定逻辑是纯函数，独立于任何调用方——任何入口（Web / IM / 未来渠道）
 *    都要经过同一道门，无法绕过（"无旁路"）。
 *  - 判定的结果是 provideReason / 放行 / 需确认，可单测、可审计。
 */
export type ToolMode = 'readonly' | 'ask' | 'execute';

export interface PermissionDecision {
  allowed: boolean;
  mode: ToolMode;
  /** 是否需用户确认（mode==='ask' 时） */
  needsConfirmation: boolean;
  reason: string;
}

/** 工具 → 权限模式注册表（唯一权威权限矩阵） */
const MODE_REGISTRY: Record<string, ToolMode> = {
  query_pen_metrics: 'readonly',
  query_operation_sop: 'readonly',
  record_health_observation: 'execute',
  create_inspection_task: 'ask',
};

export function modeForTool(name: string): ToolMode {
  // 未登记的工具默认走 ask（fail-closed：不静默放行，必须确认）
  return MODE_REGISTRY[name] ?? 'ask';
}

/**
 * 判定一次工具调用是否允许以及是否需要确认。
 * 纯函数：不依赖全局状态，任何调用方传入同样参数得到同样结果（可测、可审计）。
 */
export function decidePermissions(
  toolName: string,
  args: Record<string, unknown>,
): PermissionDecision {
  const mode = modeForTool(toolName);

  if (mode === 'readonly') {
    return { allowed: true, mode, needsConfirmation: false, reason: '只读操作，直接放行' };
  }
  if (mode === 'execute') {
    return { allowed: true, mode, needsConfirmation: false, reason: '已授权自动执行' };
  }
  // ask：允许执行，但需用户确认
  return {
    allowed: true,
    mode,
    needsConfirmation: true,
    reason: `需要用户确认写操作 ${toolName}(${JSON.stringify(args)})`,
  };
}