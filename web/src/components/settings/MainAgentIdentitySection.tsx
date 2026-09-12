import { useEffect, useState } from 'react';
import { Bot, ChevronDown, ChevronUp, History, Loader2, Save } from 'lucide-react';

import { api } from '../../api/client';
import { useAuthStore } from '../../stores/auth';
import { showToast } from '../../utils/toast';
import type { Persona, PersonaVersion } from '../../types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { SettingsCard as Section } from './SettingsCard';

const SEGMENT_FIELDS: Array<{
  key: 'identity' | 'soul' | 'agents' | 'tools';
  label: string;
  hint: string;
  rows: number;
}> = [
  {
    key: 'identity',
    label: '身份（Identity）',
    hint: '智能体是谁：名字、角色、说话方式',
    rows: 3,
  },
  {
    key: 'soul',
    label: '灵魂（Soul）',
    hint: '性格与价值倾向，影响回答的语气和取舍',
    rows: 3,
  },
  {
    key: 'agents',
    label: '任务说明（Agents）',
    hint: '面对任务的工作方式与步骤约定',
    rows: 3,
  },
  {
    key: 'tools',
    label: '工具说明（Tools）',
    hint: '可用工具的使用约定与限制',
    rows: 3,
  },
];

/** 智能体身份（Persona）：四段 prompt + 不可变版本快照，PUT 走统一写管线 */
export function MainAgentIdentitySection() {
  const canManage = useAuthStore((s) => s.canManage());
  const [persona, setPersona] = useState<Persona | null>(null);
  const [name, setName] = useState('');
  const [segments, setSegments] = useState({ identity: '', soul: '', agents: '', tools: '' });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [versions, setVersions] = useState<PersonaVersion[]>([]);
  const [showVersions, setShowVersions] = useState(false);
  const [versionsLoading, setVersionsLoading] = useState(false);

  useEffect(() => {
    api
      .get<Persona>('/api/persona')
      .then((p) => {
        setPersona(p);
        setName(p.name);
        setSegments({ ...p.segments });
      })
      .catch((err) =>
        showToast('加载失败', err instanceof Error ? err.message : String(err)),
      )
      .finally(() => setLoading(false));
  }, []);

  const loadVersions = async () => {
    setVersionsLoading(true);
    try {
      const rows = await api.get<PersonaVersion[]>('/api/persona/versions');
      setVersions(rows);
    } catch (err) {
      showToast('加载失败', err instanceof Error ? err.message : String(err));
    } finally {
      setVersionsLoading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const updated = await api.put<Persona>('/api/persona', {
        name,
        identityPrompt: segments.identity,
        soulPrompt: segments.soul,
        agentsPrompt: segments.agents,
        toolsPrompt: segments.tools,
      });
      setPersona(updated);
      setName(updated.name);
      setSegments({ ...updated.segments });
      showToast('身份已保存', `版本 ${updated.version}，下一回合自动生效`);
      if (showVersions) await loadVersions();
    } catch (err) {
      showToast('保存失败', err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <Section icon={Bot} title="智能体身份" desc="加载中…">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> 读取 Persona…
        </div>
      </Section>
    );
  }

  return (
    <Section
      icon={Bot}
      title="智能体身份"
      desc={
        persona
          ? `当前版本 v${persona.version} · identityHash ${persona.identityHash.slice(0, 12)}…`
          : undefined
      }
    >
      {persona && (
        <p className="text-xs text-muted-foreground">
          保存后会重算身份指纹并生成不可变版本快照；运行中的会话在下一回合自动重建生效。
        </p>
      )}

      <div>
        <Label htmlFor="persona-name" className="mb-1.5 text-sm">
          名称
        </Label>
        <Input
          id="persona-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={!canManage}
          className="h-9 max-w-sm"
          maxLength={80}
        />
      </div>

      {SEGMENT_FIELDS.map((field) => (
        <div key={field.key}>
          <Label htmlFor={`persona-${field.key}`} className="mb-1.5 text-sm">
            {field.label}{' '}
            <span className="text-muted-foreground font-normal">
              — {field.hint}
            </span>
          </Label>
          <Textarea
            id={`persona-${field.key}`}
            value={segments[field.key]}
            onChange={(e) => setSegments({ ...segments, [field.key]: e.target.value })}
            disabled={!canManage}
            rows={field.rows}
          />
        </div>
      ))}

      {canManage ? (
        <div className="flex items-center gap-2">
          <Button type="button" size="sm" onClick={() => void handleSave()} disabled={saving}>
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
            保存身份
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              const next = !showVersions;
              setShowVersions(next);
              if (next) void loadVersions();
            }}
          >
            <History className="size-3.5" />
            版本历史
            {showVersions ? (
              <ChevronUp className="size-3.5" />
            ) : (
              <ChevronDown className="size-3.5" />
            )}
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">需要管理员权限才能修改身份。</p>
      )}

      {showVersions && (
        <div className="rounded-lg border border-border bg-muted/20 p-3">
          {versionsLoading ? (
            <p className="py-1 text-sm text-muted-foreground">加载中…</p>
          ) : versions.length === 0 ? (
            <p className="py-1 text-sm text-muted-foreground">暂无版本记录。</p>
          ) : (
            <ul className="max-h-56 space-y-2 overflow-y-auto text-xs">
              {versions.map((v) => (
                <li key={v.version} className="rounded-md border border-border/60 bg-background px-2.5 py-2">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-foreground">v{v.version}</span>
                    <span className="text-muted-foreground/60">{v.identityHash.slice(0, 12)}…</span>
                    <span className="ml-auto text-muted-foreground">
                      {v.createdAt ? new Date(v.createdAt).toLocaleString('zh-CN', { hour12: false }) : '—'}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Section>
  );
}
