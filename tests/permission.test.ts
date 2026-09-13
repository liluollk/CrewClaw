/**
 * 权限门测试：（PermissionGate）“无旁路 + fail-closed”。
 * 这些测试是回归证据——它们证明写操作必须经确认、未登记工具默认拒绝。
 * 运行：npx vitest run
 */
import { describe, expect, it } from 'vitest';
import { decidePermissions, modeForTool } from '../src/permissions/permission.js';

describe('PermissionGate 权限门', () => {
  it('只读工具直接放行，无需确认', () => {
    const d = decidePermissions('query_pen_metrics', { penId: 'A3' });
    expect(d.allowed).toBe(true);
    expect(d.needsConfirmation).toBe(false);
    expect(d.mode).toBe('readonly');
    expect(modeForTool('query_operation_sop')).toBe('readonly');
  });

  it('自动执行工具（execute）放行并审计，无需确认', () => {
    const d = decidePermissions('record_health_observation', { penId: 'A3', symptoms: '咳嗽' });
    expect(d.allowed).toBe(true);
    expect(d.needsConfirmation).toBe(false);
    expect(d.mode).toBe('execute');
  });

  it('写工具（ask）允许但需确认', () => {
    const d = decidePermissions('create_inspection_task', { penId: 'A3' });
    expect(d.allowed).toBe(true);
    expect(d.needsConfirmation).toBe(true);
    expect(d.mode).toBe('ask');
  });

  it('未登记工具走 ask（fail-closed：不静默放行，必须确认）', () => {
    const d = decidePermissions('delete_workspace', {});
    expect(d.allowed).toBe(true);
    expect(d.needsConfirmation).toBe(true); // fail-closed：未知工具一律走确认
    expect(d.mode).toBe('ask');
  });

  it('权限判定是纯函数：同一输入恒得同一输出（可测、可审计）', () => {
    const a = decidePermissions('create_inspection_task', { penId: 'A3', reason: '采食量下降' });
    const b = decidePermissions('create_inspection_task', { penId: 'A3', reason: '采食量下降' });
    expect(a).toEqual(b);
  });
});
