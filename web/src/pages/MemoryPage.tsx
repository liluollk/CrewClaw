import { useCallback, useEffect, useRef, useState } from 'react';
import { BrainCircuit, Plus, RefreshCw, Search, History } from 'lucide-react';
import { api } from '../api/client';
import { useAuthStore } from '../stores/auth';
import { showToast } from '../utils/toast';
import { parseDbTime } from '../utils/db-time';
import type { MemoryItem, MemoryKind, MemoryVersion } from '../types';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { EmptyState } from '@/components/common/EmptyState';
import { PageHeader } from '@/components/common/PageHeader';
import { SkeletonCardList } from '@/components/common/Skeletons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const MEMORY_KINDS: MemoryKind[] = ['fact', 'decision', 'lesson', 'open_loop'];

const KIND_LABELS: Record<MemoryKind, string> = {
  fact: '事实',
  decision: '决策',
  lesson: '教训',
  open_loop: '待办',
};

function formatTime(value: string | null | undefined): string {
  const d = parseDbTime(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('zh-CN', { hour12: false });
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message || fallback;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String((error as { message?: unknown }).message) || fallback;
  }
  return fallback;
}

interface Draft {
  kind: MemoryKind;
  title: string;
  content: string;
}

const EMPTY_DRAFT: Draft = { kind: 'fact', title: '', content: '' };

/** 工作区记忆页（对齐 /api/memory*：CAS revision 语义 + 版本历史） */
export function MemoryPage() {
  const canManage = useAuthStore((s) => s.canManage());
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [kindFilter, setKindFilter] = useState<'all' | MemoryKind>('all');
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const [detailItem, setDetailItem] = useState<MemoryItem | null>(null);
  const [editDraft, setEditDraft] = useState<Draft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [versions, setVersions] = useState<MemoryVersion[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [showVersions, setShowVersions] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [createDraft, setCreateDraft] = useState<Draft>(EMPTY_DRAFT);

  const [pendingDelete, setPendingDelete] = useState<MemoryItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  const loadList = useCallback(async (q: string) => {
    setListLoading(true);
    try {
      const path = q ? `/api/memory?q=${encodeURIComponent(q)}&limit=50` : '/api/memory?limit=50';
      const rows = await api.get<MemoryItem[]>(path);
      setItems(rows);
    } catch (err) {
      showToast('加载失败', getErrorMessage(err, '无法读取记忆列表'));
    } finally {
      setListLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadList('');
  }, [loadList]);

  // 搜索防抖
  useEffect(() => {
    clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      void loadList(query.trim());
    }, 300);
    return () => clearTimeout(searchTimerRef.current);
  }, [query, loadList]);

  const openDetail = async (item: MemoryItem) => {
    setDetailItem(item);
    setEditDraft({ kind: item.kind, title: item.title, content: item.content });
    setShowVersions(false);
    setVersions([]);
  };

  const loadVersions = async (item: MemoryItem) => {
    setShowVersions(true);
    setVersionsLoading(true);
    try {
      const rows = await api.get<MemoryVersion[]>(`/api/memory/${item.id}/versions`);
      setVersions(rows);
    } catch (err) {
      showToast('加载失败', getErrorMessage(err, '无法读取版本历史'));
    } finally {
      setVersionsLoading(false);
    }
  };

  const handleCreate = async () => {
    if (!createDraft.content.trim()) {
      showToast('内容必填', '请输入要记住的内容');
      return;
    }
    setSaving(true);
    try {
      await api.post('/api/memory', {
        kind: createDraft.kind,
        title: createDraft.title.trim() || undefined,
        content: createDraft.content,
      });
      setCreateOpen(false);
      setCreateDraft(EMPTY_DRAFT);
      showToast('已记住');
      await loadList(query.trim());
    } catch (err) {
      showToast('创建失败', getErrorMessage(err, '无法创建记忆'));
    } finally {
      setSaving(false);
    }
  };

  const handleUpdate = async () => {
    if (!detailItem) return;
    if (!editDraft.content.trim()) {
      showToast('内容必填', '内容不能为空');
      return;
    }
    setSaving(true);
    try {
      const updated = await api.put<MemoryItem>(`/api/memory/${detailItem.id}`, {
        content: editDraft.content,
        title: editDraft.title.trim() || undefined,
        expectedRevision: detailItem.revision,
      });
      setDetailItem(updated);
      showToast('已更新', `revision → ${updated.revision}`);
      await loadList(query.trim());
    } catch (err) {
      showToast('更新失败', getErrorMessage(err, '可能存在并发修改，请刷新后重试'));
      await loadList(query.trim());
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await api.delete(`/api/memory/${pendingDelete.id}`, {
        expectedRevision: pendingDelete.revision,
      });
      setPendingDelete(null);
      if (detailItem?.id === pendingDelete.id) setDetailItem(null);
      showToast('已遗忘');
      await loadList(query.trim());
    } catch (err) {
      showToast('删除失败', getErrorMessage(err, '可能存在并发修改，请刷新后重试'));
    } finally {
      setDeleting(false);
    }
  };

  const visibleItems = items.filter(
    (item) => kindFilter === 'all' || item.kind === kindFilter,
  );

  return (
    <div className="min-h-full bg-background">
      <div className="mx-auto max-w-6xl p-4 sm:p-6">
        <PageHeader
          title="工作区记忆"
          subtitle="智能体在对话中沉淀的长期记忆，按工作区隔离"
          className="mb-5 flex-col !items-stretch [&>div:first-child]:w-full [&>div:last-child]:justify-end sm:flex-row sm:!items-center sm:[&>div:first-child]:w-auto"
          actions={
            <div className="flex flex-wrap items-center gap-2 sm:gap-3">
              <Button variant="outline" onClick={() => void loadList(query.trim())}>
                <RefreshCw className={listLoading ? 'animate-spin' : ''} />
                刷新
              </Button>
              {canManage && (
                <Button onClick={() => setCreateOpen(true)}>
                  <Plus />
                  新增记忆
                </Button>
              )}
            </div>
          }
        />

        <div className="mb-5 flex flex-col gap-3 border-b border-border pb-4 sm:flex-row sm:items-center sm:justify-between">
          <label className="relative block min-w-0 flex-1 sm:max-w-xs">
            <span className="sr-only">搜索记忆</span>
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索记忆内容"
              className="pl-8"
            />
          </label>
          <div className="flex flex-wrap gap-1.5">
            {(['all', ...MEMORY_KINDS] as const).map((kind) => (
              <button
                key={kind}
                type="button"
                onClick={() => setKindFilter(kind)}
                className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors cursor-pointer ${
                  kindFilter === kind
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border text-muted-foreground hover:bg-accent'
                }`}
              >
                {kind === 'all' ? '全部' : KIND_LABELS[kind]}
              </button>
            ))}
          </div>
        </div>

        {listLoading && items.length === 0 ? (
          <SkeletonCardList count={4} />
        ) : visibleItems.length === 0 ? (
          <EmptyState
            icon={BrainCircuit}
            title={query || kindFilter !== 'all' ? '没有匹配的记忆' : '还没有工作区记忆'}
            description={
              query || kindFilter !== 'all'
                ? '换个关键词或筛选条件试试。'
                : '智能体在对话中通过 remember 工具沉淀的记忆会出现在这里。'
            }
            action={
              canManage && !query && kindFilter === 'all' ? (
                <Button onClick={() => setCreateOpen(true)}>
                  <Plus />
                  新增记忆
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {visibleItems.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => void openDetail(item)}
                className="rounded-xl border border-border bg-surface p-4 text-left shadow-card transition-colors hover:border-border/80 hover:bg-accent/30 cursor-pointer"
              >
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="text-[10px]">
                    {KIND_LABELS[item.kind] ?? item.kind}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
                    {item.title || '（无标题）'}
                  </span>
                </div>
                <p className="mt-2 line-clamp-3 whitespace-pre-wrap break-words text-[13px] leading-5 text-muted-foreground">
                  {item.content}
                </p>
                <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                  <span>更新于 {formatTime(item.updatedAt)}</span>
                  <span className="text-muted-foreground/40">·</span>
                  <span>rev {item.revision}</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 详情 / 编辑对话框 */}
      <Dialog open={!!detailItem} onOpenChange={(v) => !v && setDetailItem(null)}>
        <DialogContent className="max-w-xl">
          {detailItem && (
            <>
              <DialogHeader>
                <DialogTitle>记忆详情</DialogTitle>
                <DialogDescription>
                  {KIND_LABELS[detailItem.kind] ?? detailItem.kind} · rev {detailItem.revision} · 更新于{' '}
                  {formatTime(detailItem.updatedAt)}
                </DialogDescription>
              </DialogHeader>

              {canManage ? (
                <div className="space-y-3">
                  <div>
                    <Label htmlFor="memory-title" className="mb-1.5 text-sm">
                      标题
                    </Label>
                    <Input
                      id="memory-title"
                      value={editDraft.title}
                      onChange={(e) => setEditDraft({ ...editDraft, title: e.target.value })}
                      className="h-9"
                      placeholder="（可选）"
                    />
                  </div>
                  <div>
                    <Label htmlFor="memory-content" className="mb-1.5 text-sm">
                      内容
                    </Label>
                    <Textarea
                      id="memory-content"
                      value={editDraft.content}
                      onChange={(e) => setEditDraft({ ...editDraft, content: e.target.value })}
                      rows={5}
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <Button variant="ghost" size="sm" onClick={() => void loadVersions(detailItem)}>
                      <History className="size-4" />
                      版本历史
                    </Button>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        onClick={() => setPendingDelete(detailItem)}
                        className="text-destructive hover:bg-destructive/10"
                      >
                        遗忘
                      </Button>
                      <Button onClick={() => void handleUpdate()} disabled={saving}>
                        {saving && <RefreshCw className="size-4 animate-spin" />}
                        保存
                      </Button>
                    </div>
                  </div>

                  {showVersions && (
                    <div className="rounded-lg border border-border bg-muted/20 p-3">
                      <h4 className="mb-2 text-xs font-semibold text-foreground">版本历史</h4>
                      {versionsLoading ? (
                        <p className="py-1 text-sm text-muted-foreground">加载中…</p>
                      ) : versions.length === 0 ? (
                        <p className="py-1 text-sm text-muted-foreground">暂无版本记录。</p>
                      ) : (
                        <ul className="max-h-48 space-y-1.5 overflow-y-auto text-xs">
                          {versions.map((v) => (
                            <li key={v.revision} className="flex items-center gap-2">
                              <span className="font-medium text-foreground">rev {v.revision}</span>
                              <span className="text-muted-foreground">{v.changeType}</span>
                              <span className="text-muted-foreground/60">
                                {formatTime(v.createdAt)}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                <div className="whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/20 p-3 text-sm text-foreground">
                  {detailItem.content}
                </div>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* 新建对话框 */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>新增记忆</DialogTitle>
            <DialogDescription>记忆会注入该工作区智能体的长期上下文。</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="mb-1.5 text-sm">类型</Label>
              <Select
                value={createDraft.kind}
                onValueChange={(v) => setCreateDraft({ ...createDraft, kind: v as MemoryKind })}
              >
                <SelectTrigger className="h-9 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MEMORY_KINDS.map((kind) => (
                    <SelectItem key={kind} value={kind}>
                      {KIND_LABELS[kind]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="create-title" className="mb-1.5 text-sm">
                标题
              </Label>
              <Input
                id="create-title"
                value={createDraft.title}
                onChange={(e) => setCreateDraft({ ...createDraft, title: e.target.value })}
                className="h-9"
                placeholder="（可选）"
              />
            </div>
            <div>
              <Label htmlFor="create-content" className="mb-1.5 text-sm">
                内容
              </Label>
              <Textarea
                id="create-content"
                value={createDraft.content}
                onChange={(e) => setCreateDraft({ ...createDraft, content: e.target.value })}
                rows={4}
                placeholder="要记住的内容"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={saving}>
                取消
              </Button>
              <Button onClick={() => void handleCreate()} disabled={saving}>
                保存
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* 遗忘确认 */}
      <ConfirmDialog
        open={!!pendingDelete}
        onClose={() => {
          if (!deleting) setPendingDelete(null);
        }}
        onConfirm={() => void handleDelete()}
        title="遗忘这条记忆？"
        message={pendingDelete ? `「${pendingDelete.title || pendingDelete.content.slice(0, 40)}」将被标记为遗忘，智能体不再召回。` : ''}
        confirmText="遗忘"
        confirmVariant="danger"
        loading={deleting}
      />
    </div>
  );
}
