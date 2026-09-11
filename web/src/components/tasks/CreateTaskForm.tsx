import { useState } from 'react';
import { Loader2, X } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { ScheduleSpec } from '../../types';

type ScheduleMode = 'interval' | 'daily' | 'once';

interface CreateTaskFormProps {
  onSubmit: (data: { name: string; prompt: string; schedule: ScheduleSpec }) => Promise<void>;
  onClose: () => void;
}

/** 创建定时任务（频率模型对齐后端：间隔分钟 / 每天时刻 / 指定时间） */
export function CreateTaskForm({ onSubmit, onClose }: CreateTaskFormProps) {
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [mode, setMode] = useState<ScheduleMode>('daily');
  const [intervalMinutes, setIntervalMinutes] = useState('30');
  const [dailyTime, setDailyTime] = useState('09:00');
  const [onceAt, setOnceAt] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const buildSchedule = (): ScheduleSpec | null => {
    if (mode === 'interval') {
      const n = parseInt(intervalMinutes, 10);
      if (!Number.isFinite(n) || n <= 0) return null;
      return { type: 'interval', minutes: n };
    }
    if (mode === 'daily') {
      const [h, m] = dailyTime.split(':').map((v) => parseInt(v, 10));
      if (!Number.isFinite(h) || !Number.isFinite(m) || h < 0 || h > 23 || m < 0 || m > 59) return null;
      return { type: 'daily', hour: h, minute: m };
    }
    if (!onceAt) return null;
    const at = new Date(onceAt);
    if (Number.isNaN(at.getTime())) return null;
    return { type: 'once', at: at.toISOString() };
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!name.trim()) {
      setError('请输入任务名称');
      return;
    }
    if (!prompt.trim()) {
      setError('请输入任务指令');
      return;
    }
    const schedule = buildSchedule();
    if (!schedule) {
      setError('频率配置不合法');
      return;
    }
    if (schedule.type === 'once' && schedule.at && new Date(schedule.at).getTime() <= Date.now()) {
      setError('指定时间必须晚于当前时间');
      return;
    }

    setSubmitting(true);
    try {
      await onSubmit({ name: name.trim(), prompt: prompt.trim(), schedule });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>创建定时任务</DialogTitle>
          <DialogDescription>
            任务按工作区身份执行，指令会作为一条消息发送给智能体。
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div role="alert" className="mb-2 p-3 bg-error-bg border border-error/30 rounded-lg">
            <p className="text-sm text-error">{error}</p>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Label htmlFor="task-name" className="mb-1.5 text-sm">
              任务名称
            </Label>
            <Input
              id="task-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：每天早上汇报待办"
              required
              className="h-9"
            />
          </div>

          <div>
            <Label htmlFor="task-prompt" className="mb-1.5 text-sm">
              任务指令
            </Label>
            <Textarea
              id="task-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="告诉智能体每次触发时做什么"
              rows={3}
              required
            />
          </div>

          <div>
            <Label className="mb-1.5 text-sm">执行频率</Label>
            <div className="space-y-2">
              <Select value={mode} onValueChange={(v) => setMode(v as ScheduleMode)}>
                <SelectTrigger className="h-9 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="interval">固定间隔</SelectItem>
                  <SelectItem value="daily">每天定时</SelectItem>
                  <SelectItem value="once">指定时间（一次）</SelectItem>
                </SelectContent>
              </Select>

              {mode === 'interval' && (
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min={1}
                    value={intervalMinutes}
                    onChange={(e) => setIntervalMinutes(e.target.value)}
                    className="h-9 w-28"
                    aria-label="间隔分钟数"
                  />
                  <span className="text-sm text-muted-foreground">分钟一次</span>
                </div>
              )}

              {mode === 'daily' && (
                <div className="flex items-center gap-2">
                  <Input
                    type="time"
                    value={dailyTime}
                    onChange={(e) => setDailyTime(e.target.value)}
                    className="h-9 w-32"
                    aria-label="每天执行时刻"
                  />
                  <span className="text-sm text-muted-foreground">每天执行</span>
                </div>
              )}

              {mode === 'once' && (
                <Input
                  type="datetime-local"
                  value={onceAt}
                  onChange={(e) => setOnceAt(e.target.value)}
                  className="h-9 w-56"
                  aria-label="指定执行时间"
                />
              )}
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
              <X className="size-4" />
              取消
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting && <Loader2 className="size-4 animate-spin" />}
              创建任务
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
