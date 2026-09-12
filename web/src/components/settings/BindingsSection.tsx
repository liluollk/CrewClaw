import { useEffect, useState } from 'react';
import { Cable, Loader2, Save, Trash2 } from 'lucide-react';

import { api } from '../../api/client';
import { useAuthStore } from '../../stores/auth';
import { showToast } from '../../utils/toast';
import type { ChannelInfo } from '../../types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { SettingsCard as Section } from './SettingsCard';

const CHANNEL_META: Record<
  ChannelInfo['kind'],
  { label: string; fields: Array<{ key: string; label: string; placeholder: string }> }
> = {
  feishu: {
    label: '飞书',
    fields: [
      { key: 'appId', label: 'App ID', placeholder: 'cli_xxx' },
      { key: 'appSecret', label: 'App Secret', placeholder: '留空则沿用已保存的密钥' },
    ],
  },
  dingtalk: {
    label: '钉钉',
    fields: [
      { key: 'clientId', label: 'Client ID', placeholder: '钉钉应用 Client ID' },
      { key: 'clientSecret', label: 'Client Secret', placeholder: '留空则沿用已保存的密钥' },
    ],
  },
};

type Draft = { accountId: string; credentials: Record<string, string>; enabled: boolean };

function ChannelRow({ info, canManage, onSaved }: {
  info: ChannelInfo;
  canManage: boolean;
  onSaved: () => void;
}) {
  const meta = CHANNEL_META[info.kind];
  const [draft, setDraft] = useState<Draft>({
    accountId: info.accountId,
    credentials: {},
    enabled: info.enabled,
  });
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      // credentials 为空对象 → 后端沿用旧密文；非空 → 校验并覆盖加密存储
      await api.put(`/api/channels/${info.kind}`, draft);
      showToast('渠道配置已保存', meta.label);
      onSaved();
    } catch (err) {
      showToast('保存失败', err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setSaving(true);
    try {
      await api.delete(`/api/channels/${info.kind}`);
      showToast('渠道配置已删除', meta.label);
      onSaved();
    } catch (err) {
      showToast('删除失败', err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-lg border border-border p-4">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-foreground">{meta.label}</span>
        {info.configured ? (
          <Badge variant="outline" className="text-[10px] border-emerald-200 text-emerald-700 dark:border-emerald-800 dark:text-emerald-300">
            已配置
          </Badge>
        ) : (
          <Badge variant="outline" className="text-[10px] text-muted-foreground">
            未配置
          </Badge>
        )}
        <span className="flex-1" />
        <Switch
          checked={draft.enabled}
          disabled={!canManage || saving || (!info.configured && Object.keys(draft.credentials).length === 0)}
          onCheckedChange={(v) => setDraft({ ...draft, enabled: v })}
        />
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div>
          <Label className="mb-1.5 text-xs text-muted-foreground">账号标识（可选）</Label>
          <Input
            value={draft.accountId}
            onChange={(e) => setDraft({ ...draft, accountId: e.target.value })}
            disabled={!canManage}
            className="h-9"
            placeholder="例如：main"
          />
        </div>
        {meta.fields.map((field) => (
          <div key={field.key}>
            <Label className="mb-1.5 text-xs text-muted-foreground">{field.label}</Label>
            <Input
              type="password"
              value={draft.credentials[field.key] ?? ''}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  credentials: { ...draft.credentials, [field.key]: e.target.value },
                })
              }
              disabled={!canManage}
              className="h-9"
              placeholder={field.placeholder}
              autoComplete="new-password"
            />
          </div>
        ))}
      </div>

      {canManage && (
        <div className="mt-3 flex items-center gap-2">
          <Button type="button" size="sm" onClick={() => void handleSave()} disabled={saving}>
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
            保存
          </Button>
          {info.configured && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void handleDelete()}
              disabled={saving}
              className="text-destructive hover:bg-destructive/10"
            >
              <Trash2 className="size-3.5" />
              删除配置
            </Button>
          )}
          <span className="text-xs text-muted-foreground">
            凭据服务端加密存储，保存后不会回传明文。
          </span>
        </div>
      )}
    </div>
  );
}

/** IM 渠道配置：工作区级飞书 / 钉钉接入（凭据密文由后端保管） */
export function BindingsSection() {
  const canManage = useAuthStore((s) => s.canManage());
  const [channels, setChannels] = useState<ChannelInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const load = () => {
    api
      .get<ChannelInfo[]>('/api/channels')
      .then(setChannels)
      .catch(() => setChannels([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, []);

  return (
    <Section
      icon={Cable}
      title="IM 渠道"
      desc="把飞书 / 钉钉接入当前工作区，消息直达同一个智能体"
    >
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> 读取渠道配置…
        </div>
      ) : (
        <div className="space-y-3">
          {(['feishu', 'dingtalk'] as const).map((kind) => {
            const info = channels.find((c) => c.kind === kind) ?? {
              kind,
              accountId: '',
              enabled: false,
              configured: false,
            };
            return <ChannelRow key={kind} info={info} canManage={canManage} onSaved={load} />;
          })}
        </div>
      )}
    </Section>
  );
}
