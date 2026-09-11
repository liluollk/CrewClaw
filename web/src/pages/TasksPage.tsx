import { useEffect, useState } from 'react';
import { Clock, Plus, RefreshCw, Search } from 'lucide-react';
import { TaskCard } from '../components/tasks/TaskCard';
import { CreateTaskForm } from '../components/tasks/CreateTaskForm';
import { useTasksStore } from '../stores/tasks';
import { useAuthStore } from '../stores/auth';
import { showToast } from '../utils/toast';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { EmptyState } from '@/components/common/EmptyState';
import { PageHeader } from '@/components/common/PageHeader';
import { SkeletonCardList } from '@/components/common/Skeletons';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { ScheduleSpec } from '../types';

/**
 * 定时任务页（无回收站/停止运行/通知/脚本执行）。
 */
export function TasksPage() {
  const { tasks, loaded, load, create, update, remove } = useTasksStore();
  const canManage = useAuthStore((s) => s.canManage());
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [query, setQuery] = useState('');
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  useEffect(() => {
    void load();
  }, [load]);

  const enabledCount = tasks.filter((t) => t.enabled).length;

  const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN');
  const filteredTasks = tasks.filter((task) => {
    if (!normalizedQuery) return true;
    return [task.name, task.prompt, task.id]
      .filter(Boolean)
      .some((value) => String(value).toLocaleLowerCase('zh-CN').includes(normalizedQuery));
  });

  const handleCreate = async (data: {
    name: string;
    prompt: string;
    schedule: ScheduleSpec;
  }) => {
    await create(data);
    setShowCreateForm(false);
    showToast('任务已创建', '可点击卡片上的闪电按钮立即执行');
  };

  const handleToggle = async (id: string, enabled: boolean) => {
    try {
      await update(id, { enabled });
    } catch (err) {
      showToast('操作失败', err instanceof Error ? err.message : String(err));
    }
  };

  const handleDelete = async () => {
    if (!pendingDeleteId || actionLoading) return;
    setActionLoading(true);
    try {
      await remove(pendingDeleteId);
      setPendingDeleteId(null);
      showToast('任务已删除');
    } catch (err) {
      showToast('删除失败', err instanceof Error ? err.message : String(err));
    } finally {
      setActionLoading(false);
    }
  };

  const pendingTask = tasks.find((t) => t.id === pendingDeleteId);

  return (
    <div className="min-h-full bg-background">
      <div className="mx-auto max-w-6xl p-4 sm:p-6">
        <PageHeader
          title="定时任务"
          subtitle={`共 ${tasks.length} 个 · ${enabledCount} 个已启用`}
          className="mb-5 flex-col !items-stretch [&>div:first-child]:w-full [&>div:last-child]:justify-end sm:flex-row sm:!items-center sm:[&>div:first-child]:w-auto"
          actions={
            <div className="flex flex-wrap items-center gap-2 sm:gap-3">
              <Button variant="outline" onClick={() => void load()} disabled={!loaded && tasks.length === 0}>
                <RefreshCw className="" />
                刷新
              </Button>
              {canManage && (
                <Button onClick={() => setShowCreateForm(true)}>
                  <Plus />
                  创建任务
                </Button>
              )}
            </div>
          }
        />

        <div className="mb-5 flex flex-col gap-3 border-b border-border pb-4 sm:flex-row sm:items-center sm:justify-between">
          <label className="relative block min-w-0 flex-1 sm:max-w-xs">
            <span className="sr-only">搜索定时任务</span>
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索任务"
              className="pl-8"
            />
          </label>
        </div>

        {!loaded && tasks.length === 0 ? (
          <SkeletonCardList count={4} />
        ) : filteredTasks.length === 0 ? (
          <EmptyState
            icon={Clock}
            title={normalizedQuery ? '没有匹配的任务' : '当前没有定时任务'}
            description={
              normalizedQuery
                ? '可以换个关键词，或清除搜索条件。'
                : canManage
                  ? '创建一个定时任务，让智能体按计划自动执行工作。'
                  : '该工作区还没有定时任务。'
            }
            action={
              normalizedQuery ? (
                <Button variant="outline" onClick={() => setQuery('')}>
                  清除搜索
                </Button>
              ) : canManage ? (
                <Button onClick={() => setShowCreateForm(true)}>
                  <Plus />
                  创建任务
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="space-y-3">
            {filteredTasks.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                canManage={canManage}
                onEditEnabled={(id, enabled) => void handleToggle(id, enabled)}
                onDelete={setPendingDeleteId}
              />
            ))}
          </div>
        )}
      </div>

      {showCreateForm && (
        <CreateTaskForm
          onSubmit={handleCreate}
          onClose={() => setShowCreateForm(false)}
        />
      )}

      <ConfirmDialog
        open={!!pendingDeleteId}
        onClose={() => {
          if (!actionLoading) setPendingDeleteId(null);
        }}
        onConfirm={handleDelete}
        title={`删除任务「${pendingTask?.name ?? ''}」？`}
        message="任务定义和运行历史都会被永久删除，此操作无法撤销。"
        confirmText="删除任务"
        confirmVariant="danger"
        loading={actionLoading}
      />
    </div>
  );
}
