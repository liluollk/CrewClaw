import { useEffect, useState } from 'react';
import { Loader2, Plus, Trash2, Users } from 'lucide-react';

import { api } from '../../api/client';
import { useAuthStore } from '../../stores/auth';
import { showToast } from '../../utils/toast';
import type { WorkspaceMember, WorkspaceRole } from '../../types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SettingsCard as Section } from './SettingsCard';

const ROLE_LABELS: Record<WorkspaceRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
};

/** 工作区成员管理（对齐 /api/workspace/members CRUD；member 角色不可见） */
export function MembersSection() {
  const canManage = useAuthStore((s) => s.canManage());
  const currentUserId = useAuthStore((s) => s.user?.id);
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [username, setUsername] = useState('');
  const [role, setRole] = useState<'admin' | 'member'>('member');
  const [busy, setBusy] = useState(false);

  const load = () => {
    api
      .get<WorkspaceMember[]>('/api/workspace/members')
      .then(setMembers)
      .catch(() => setMembers([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, []);

  if (!canManage) return null;

  const handleAdd = async () => {
    if (!username.trim()) return;
    setBusy(true);
    try {
      await api.post('/api/workspace/members', { username: username.trim(), role });
      setUsername('');
      showToast('成员已添加');
      load();
    } catch (err) {
      showToast('添加失败', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleRoleChange = async (userId: string, nextRole: string) => {
    setBusy(true);
    try {
      await api.patch(`/api/workspace/members/${userId}`, { role: nextRole });
      showToast('角色已更新');
      load();
    } catch (err) {
      showToast('更新失败', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async (userId: string) => {
    setBusy(true);
    try {
      await api.delete(`/api/workspace/members/${userId}`);
      showToast('成员已移除');
      load();
    } catch (err) {
      showToast('移除失败', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section icon={Users} title="成员管理" desc="添加成员并分配角色；Owner 不可变更或移除">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1">
          <Label htmlFor="member-username" className="mb-1.5 text-xs text-muted-foreground">
            用户名
          </Label>
          <Input
            id="member-username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="已注册的用户名"
            className="h-9"
          />
        </div>
        <div>
          <Label className="mb-1.5 block text-xs text-muted-foreground">角色</Label>
          <Select value={role} onValueChange={(v) => setRole(v as 'admin' | 'member')}>
            <SelectTrigger className="h-9 w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="member">Member</SelectItem>
              <SelectItem value="admin">Admin</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button type="button" size="sm" onClick={() => void handleAdd()} disabled={busy}>
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
          添加
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> 读取成员列表…
        </div>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {members.map((member) => (
            <li key={member.userId} className="flex items-center gap-3 px-3 py-2.5">
              <div className="size-8 shrink-0 rounded-full bg-primary/10 flex items-center justify-center text-xs font-semibold text-primary">
                {(member.displayName || member.username)[0]?.toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">
                  {member.displayName || member.username}
                  {member.userId === currentUserId && (
                    <span className="ml-1.5 text-xs text-muted-foreground">（我）</span>
                  )}
                </p>
                <p className="truncate text-xs text-muted-foreground">@{member.username}</p>
              </div>
              {member.role === 'owner' ? (
                <span className="shrink-0 text-xs font-medium text-muted-foreground">
                  {ROLE_LABELS.owner}
                </span>
              ) : (
                <>
                  <Select
                    value={member.role}
                    onValueChange={(v) => void handleRoleChange(member.userId, v)}
                    disabled={busy}
                  >
                    <SelectTrigger className="h-8 w-24 shrink-0">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="admin">Admin</SelectItem>
                      <SelectItem value="member">Member</SelectItem>
                    </SelectContent>
                  </Select>
                  <button
                    type="button"
                    onClick={() => void handleRemove(member.userId)}
                    disabled={busy}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-red-50 hover:text-red-600 disabled:opacity-50 dark:hover:bg-red-950/40"
                    title="移除成员"
                    aria-label="移除成员"
                  >
                    <Trash2 className="size-4" />
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
