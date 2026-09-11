import { useEffect, useState } from 'react';
import {
  ChevronDown,
  ChevronUp,
  Clock,
  History,
  Loader2,
  Pause,
  Play,
  Trash2,
  Zap,
} from 'lucide-react';
import { useTasksStore } from '../../stores/tasks';
import type { ScheduledTask, TaskRun } from '../../types';
import { useAuthStore } from '../../stores/auth';
import { showToast } from '../../utils/toast';
import { parseDbTime } from '../../utils/db-time';
import { Badge } from '@/components/ui/badge';

interface TaskCardProps {
  task: ScheduledTask;
  onEditEnabled: (id: string, enabled: boolean) => void;
  onDelete: (id: string) => void;
  canManage: boolean;
}

/** 定时任务卡片（无回收站/停止运行/权限细粒度） */
export function TaskCard({ task, onEditEnabled, onDelete, canManage }: TaskCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [runs, setRuns] = useState<TaskRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const canManageNow = useAuthStore((s) => s.canManage());
  const runNow = useTasksStore((s) => s.runNow);
  const manageable = canManage && canManageNow;

  const loadRuns = () => {
    setRunsLoading(true);
    useTasksStore
      .getState()
      .listRuns(task.id)
      .then(setRuns)
      .catch(() => setRuns([]))
      .finally(() => setRunsLoading(false));
  };

  useEffect(() => {
    if (expanded) loadRuns();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);

  const handleRunNow = async () => {
    setRunning(true);
    try {
      await runNow(task.id);
      showToast('已触发执行', `任务「${task.name}」已进入执行队列`);
      loadRuns();
    } catch (err) {
      showToast('触发失败', err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  const statusBadge = task.enabled ? (
    <Badge className="bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800" variant="outline">
      已启用
    </Badge>
  ) : (
    <Badge variant="outline" className="text-muted-foreground">
      已停用
    </Badge>
  );

  return (
    <article className="rounded-xl border border-border bg-surface shadow-card">
      <div className="flex items-start gap-3 p-4">
        <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-primary dark:bg-brand-950/40">
          <Clock className="h-5 w-5" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="min-w-0 truncate text-sm font-semibold text-foreground">
              {task.name}
            </h3>
            {statusBadge}
          </div>
          <p className="mt-1 line-clamp-2 text-[13px] leading-5 text-muted-foreground">
            {task.prompt}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <History className="h-3.5 w-3.5" />
              {task.scheduleText}
            </span>
            {task.nextRunAt && task.enabled && (
              <span>
                下次执行：{parseDbTime(task.nextRunAt).toLocaleString('zh-CN', { hour12: false })}
              </span>
            )}
            {task.lastRunAt && (
              <span>
                上次执行：{parseDbTime(task.lastRunAt).toLocaleString('zh-CN', { hour12: false })}
              </span>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          {manageable && (
            <>
              <button
                type="button"
                onClick={handleRunNow}
                disabled={running}
                className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-brand-50 hover:text-primary disabled:cursor-not-allowed disabled:opacity-50"
                title="立即执行"
                aria-label="立即执行"
              >
                {running ? (
                  <Loader2 className="h-4.5 w-4.5 animate-spin" />
                ) : (
                  <Zap className="h-4.5 w-4.5" />
                )}
              </button>
              <button
                type="button"
                onClick={() => onEditEnabled(task.id, !task.enabled)}
                className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-brand-50 hover:text-primary"
                title={task.enabled ? '停用后续计划' : '启用后续计划'}
                aria-label={task.enabled ? '停用任务' : '启用任务'}
              >
                {task.enabled ? <Pause className="h-4.5 w-4.5" /> : <Play className="h-4.5 w-4.5" />}
              </button>
              <button
                type="button"
                onClick={() => onDelete(task.id)}
                className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40 dark:hover:text-red-400"
                title="删除任务"
                aria-label="删除任务"
              >
                <Trash2 className="h-4.5 w-4.5" />
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted"
            title={expanded ? '收起详情' : '展开详情'}
            aria-expanded={expanded}
          >
            {expanded ? <ChevronUp className="h-4.5 w-4.5" /> : <ChevronDown className="h-4.5 w-4.5" />}
          </button>
        </div>
      </div>

      {/* Expanded Detail: 运行记录 */}
      {expanded && (
        <div className="border-t border-border px-4 py-3">
          <h4 className="mb-2 text-xs font-semibold text-foreground">最近运行</h4>
          {runsLoading ? (
            <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> 加载中…
            </div>
          ) : runs.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">还没有运行记录。</p>
          ) : (
            <ul className="space-y-2">
              {runs.map((run) => (
                <li
                  key={run.id}
                  className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2"
                >
                  <div className="flex items-center gap-2 text-xs">
                    <span
                      className={`inline-flex items-center gap-1 font-medium ${
                        run.status === 'success'
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : run.status === 'running'
                            ? 'text-sky-600 dark:text-sky-400'
                            : 'text-muted-foreground'
                      }`}
                    >
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${
                          run.status === 'success'
                            ? 'bg-emerald-500'
                            : run.status === 'running'
                              ? 'bg-sky-500 animate-pulse'
                              : 'bg-muted-foreground/50'
                        }`}
                      />
                      {run.status}
                    </span>
                    <span className="text-muted-foreground">
                      {parseDbTime(run.startedAt).toLocaleString('zh-CN', { hour12: false })}
                    </span>
                  </div>
                  {run.resultText && (
                    <p className="mt-1 line-clamp-3 whitespace-pre-wrap break-words text-[13px] text-foreground/75">
                      {run.resultText}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </article>
  );
}
