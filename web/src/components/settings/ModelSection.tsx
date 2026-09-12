import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, KeyRound, Loader2, LogOut, Save, Sparkles, XCircle } from 'lucide-react';

import { api } from '../../api/client';
import { showToast } from '../../utils/toast';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SettingsCard as Section } from './SettingsCard';

interface ProviderInfo {
  access: { mode: 'custom' | 'plan'; plan?: string; model?: string; version: number };
  plans: Array<{ id: string; name: string; loggedIn: boolean }>;
  source: 'file' | 'env';
  baseUrl: string;
  modelId: string;
  apiKeyConfigured: boolean;
  version: number;
}

interface ProbeResult {
  ok: boolean;
  status: number;
  message: string;
}

interface LoginSession {
  id: string;
  plan: string;
  status: 'waiting' | 'done' | 'error' | 'cancelled';
  events: Array<{ type: string; message?: string; url?: string; userCode?: string; verificationUri?: string; instructions?: string }>;
  prompt: { type: string; message: string; placeholder?: string; options?: Array<{ id: string; label: string }> } | null;
  error: string | null;
}

/** 模型接入：自定义接口（Pi 原生 models.json/auth.json）与订阅套餐（SDK OAuth 登录）双模式 */
export function ModelSection() {
  const [info, setInfo] = useState<ProviderInfo | null>(null);
  const [mode, setMode] = useState<'custom' | 'plan'>('custom');
  const [loading, setLoading] = useState(true);

  // 自定义接口表单
  const [baseUrl, setBaseUrl] = useState('');
  const [modelId, setModelId] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<ProbeResult | null>(null);

  // 套餐登录流程
  const [login, setLogin] = useState<LoginSession | null>(null);
  const [promptAnswer, setPromptAnswer] = useState('');
  const [planModels, setPlanModels] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [activating, setActivating] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(() => {
    return api
      .get<ProviderInfo>('/api/provider')
      .then((data) => {
        setInfo(data);
        setMode(data.access.mode);
        setBaseUrl(data.baseUrl);
        setModelId(data.modelId);
      })
      .catch((err) => showToast('加载失败', err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 登录会话轮询：waiting 时每 2 秒拉状态，结束后拉套餐模型列表
  useEffect(() => {
    if (!login || login.status !== 'waiting') {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }
    const id = login.id;
    pollRef.current = setInterval(() => {
      api
        .get<LoginSession>(`/api/provider/plan-login/${id}`)
        .then((s) => {
          setLogin(s);
          if (s.status === 'done') {
            api
              .get<{ models: Array<{ id: string; name: string }> }>(`/api/provider/plan-models?plan=${s.plan}`)
              .then((r) => {
                setPlanModels(r.models);
                if (r.models[0]) setSelectedModel(r.models[0].id);
              })
              .catch(() => setPlanModels([]));
          }
        })
        .catch(() => {});
    }, 2000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [login?.id, login?.status]);

  const handleSaveCustom = async () => {
    setSaving(true);
    setProbe(null);
    try {
      await api.put('/api/provider', { baseUrl, modelId, apiKey });
      await api.post('/api/provider/activate', { mode: 'custom' });
      showToast('已保存并启用自定义接口', '下一回合对话自动生效');
      await load();
    } catch (err) {
      showToast('保存失败', err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setProbing(true);
    setProbe(null);
    try {
      const result = await api.post<ProbeResult>('/api/provider/test', { baseUrl, modelId, apiKey });
      setProbe(result);
      if (result.ok) showToast('连接正常', '模型可用');
    } catch (err) {
      showToast('测试失败', err instanceof Error ? err.message : String(err));
    } finally {
      setProbing(false);
    }
  };

  const startPlanLogin = async (plan: string) => {
    try {
      const { loginId } = await api.post<{ ok: true; loginId: string }>('/api/provider/plan-login', { plan });
      setLogin({ id: loginId, plan, status: 'waiting', events: [], prompt: null, error: null });
      setPlanModels([]);
      setPromptAnswer('');
    } catch (err) {
      showToast('发起登录失败', err instanceof Error ? err.message : String(err));
    }
  };

  const answerPrompt = async (value: string) => {
    if (!login) return;
    try {
      await api.post(`/api/provider/plan-login/${login.id}/prompt`, { value });
      setPromptAnswer('');
    } catch (err) {
      showToast('应答失败', err instanceof Error ? err.message : String(err));
    }
  };

  const cancelLogin = async () => {
    if (!login) return;
    try {
      await api.post(`/api/provider/plan-login/${login.id}/cancel`);
    } finally {
      setLogin(null);
    }
  };

  const activatePlan = async () => {
    if (!login) return;
    setActivating(true);
    try {
      await api.post('/api/provider/activate', { mode: 'plan', plan: login.plan, model: selectedModel });
      showToast('已启用套餐接入', `下一回合对话使用 ${login.plan} / ${selectedModel}`);
      await load();
    } catch (err) {
      showToast('启用失败', err instanceof Error ? err.message : String(err));
    } finally {
      setActivating(false);
    }
  };

  const activateCustom = async () => {
    setActivating(true);
    try {
      await api.post('/api/provider/activate', { mode: 'custom' });
      showToast('已切回自定义接口');
      await load();
    } finally {
      setActivating(false);
    }
  };

  const logoutPlan = async (plan: string) => {
    try {
      await api.post('/api/provider/plan-logout', { plan });
      showToast('已退出套餐登录');
      await load();
    } catch (err) {
      showToast('退出失败', err instanceof Error ? err.message : String(err));
    }
  };

  if (loading || !info) {
    return (
      <Section icon={KeyRound} title="模型接入" desc="加载中…">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> 读取接入配置…
        </div>
      </Section>
    );
  }

  const isPlanActive = info.access.mode === 'plan';

  return (
    <Section
      icon={KeyRound}
      title="模型接入"
      desc="自定义接口（URL + Key）或订阅套餐（OAuth 登录），保存后下一回合自动生效"
    >
      {/* 当前生效状态 */}
      <div className="flex items-center gap-2">
        {isPlanActive ? (
          <Badge variant="outline" className="text-[10px] border-emerald-200 text-emerald-700 dark:border-emerald-800 dark:text-emerald-300">
            生效中：套餐 {info.access.plan} / {info.access.model}
          </Badge>
        ) : (
          <Badge variant="outline" className="text-[10px] border-emerald-200 text-emerald-700 dark:border-emerald-800 dark:text-emerald-300">
            生效中：自定义接口（{info.source === 'file' ? 'Pi 配置文件' : '环境变量'}）
          </Badge>
        )}
      </div>

      {/* ── 自定义接口 ── */}
      <div className={`rounded-lg border p-4 ${mode === 'custom' ? 'border-primary/40' : 'border-border'}`}>
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-foreground">自定义接口</span>
          <span className="text-xs text-muted-foreground">OpenAI 兼容的 URL + API Key</span>
          <span className="flex-1" />
          {isPlanActive && (
            <Button type="button" variant="outline" size="sm" onClick={() => void activateCustom()} disabled={activating}>
              切换到自定义接口
            </Button>
          )}
        </div>

        {mode === 'custom' && (
          <>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <Label htmlFor="provider-base-url" className="mb-1.5 text-xs text-muted-foreground">
                  接口地址（baseUrl）
                </Label>
                <Input
                  id="provider-base-url"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  className="h-9"
                  placeholder="https://api.example.com/v1"
                />
              </div>
              <div>
                <Label htmlFor="provider-model" className="mb-1.5 text-xs text-muted-foreground">
                  模型 ID
                </Label>
                <Input
                  id="provider-model"
                  value={modelId}
                  onChange={(e) => setModelId(e.target.value)}
                  className="h-9"
                  placeholder="例如：deepseek-v4.1-flash"
                />
              </div>
              <div>
                <Label htmlFor="provider-key" className="mb-1.5 text-xs text-muted-foreground">
                  API Key{' '}
                  <span className="font-normal">
                    （{info.apiKeyConfigured ? '留空沿用已保存' : '首次必填'}）
                  </span>
                </Label>
                <Input
                  id="provider-key"
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  className="h-9"
                  placeholder={info.apiKeyConfigured ? '••••••••' : 'sk-...'}
                  autoComplete="new-password"
                />
              </div>
            </div>

            {probe && (
              <div
                role="status"
                className={`rounded-lg border px-3 py-2 text-sm ${
                  probe.ok
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300'
                    : 'border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300'
                }`}
              >
                {probe.ok ? '✓ ' : '✗ '}
                {probe.message}
                {!probe.ok && probe.status > 0 && (
                  <span className="ml-1 opacity-70">(HTTP {probe.status})</span>
                )}
              </div>
            )}

            <div className="flex items-center gap-2">
              <Button type="button" size="sm" onClick={() => void handleSaveCustom()} disabled={saving}>
                {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
                保存并启用
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => void handleTest()} disabled={probing}>
                {probing ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
                测试连接
              </Button>
            </div>
          </>
        )}
      </div>

      {/* ── 订阅套餐登录 ── */}
      <div className={`rounded-lg border p-4 ${mode === 'plan' ? 'border-primary/40' : 'border-border'}`}>
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-foreground">订阅套餐</span>
          <span className="text-xs text-muted-foreground">用账号订阅登录（OAuth），无需 API Key</span>
        </div>

        <div className="mt-3 space-y-2">
          {info.plans.map((plan) => (
            <div
              key={plan.id}
              className="flex items-center gap-2 rounded-lg border border-border px-3 py-2"
            >
              <span className="min-w-0 flex-1 truncate text-sm text-foreground">{plan.name}</span>
              {plan.loggedIn && (
                <Badge variant="outline" className="text-[10px] border-emerald-200 text-emerald-700 dark:border-emerald-800 dark:text-emerald-300">
                  <CheckCircle2 className="mr-0.5 size-3" /> 已登录
                </Badge>
              )}
              {plan.loggedIn ? (
                <Button type="button" variant="ghost" size="sm" onClick={() => void logoutPlan(plan.id)}>
                  <LogOut className="size-3.5" />
                  退出
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={login?.status === 'waiting'}
                  onClick={() => void startPlanLogin(plan.id)}
                >
                  登录
                </Button>
              )}
            </div>
          ))}
        </div>

        {/* 登录过程面板 */}
        {login && (
          <div className="mt-3 rounded-lg border border-border bg-muted/20 p-3">
            <div className="flex items-center gap-2 text-sm">
              {login.status === 'waiting' && (
                <>
                  <Loader2 className="size-4 animate-spin text-primary" />
                  正在登录 {login.plan}…
                </>
              )}
              {login.status === 'done' && (
                <>
                  <CheckCircle2 className="size-4 text-emerald-500" />
                  登录成功，请选择要使用的模型
                </>
              )}
              {(login.status === 'error' || login.status === 'cancelled') && (
                <>
                  <XCircle className="size-4 text-destructive" />
                  登录失败：{login.error ?? '已取消'}
                </>
              )}
              <span className="flex-1" />
              {login.status === 'waiting' && (
                <Button type="button" variant="ghost" size="sm" onClick={() => void cancelLogin()}>
                  取消
                </Button>
              )}
            </div>

            {/* SDK 推送的事件：授权链接 / 设备码 / 进度 */}
            <div className="mt-2 space-y-2">
              {login.events.map((e, i) => {
                if (e.type === 'auth_url' && e.url) {
                  return (
                    <div key={i} className="rounded-md border border-border bg-background px-3 py-2 text-sm">
                      <a href={e.url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                        打开授权页面 →
                      </a>
                      {e.instructions && (
                        <p className="mt-1 text-xs text-muted-foreground">{e.instructions}</p>
                      )}
                    </div>
                  );
                }
                if (e.type === 'device_code') {
                  return (
                    <div key={i} className="rounded-md border border-border bg-background px-3 py-2 text-sm">
                      <p>
                        打开{' '}
                        <a href={e.verificationUri} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                          {e.verificationUri}
                        </a>{' '}
                        并输入设备码：
                      </p>
                      <p className="mt-1 select-all font-mono text-base font-bold tracking-widest">{e.userCode}</p>
                    </div>
                  );
                }
                if (e.type === 'info' && e.message) {
                  return (
                    <p key={i} className="text-xs text-muted-foreground">
                      {e.message}
                    </p>
                  );
                }
                return null;
              })}
            </div>

            {/* SDK 等待用户输入 */}
            {login.prompt && (
              <div className="mt-2 rounded-md border border-border bg-background px-3 py-2">
                <Label className="mb-1.5 text-xs text-muted-foreground">{login.prompt.message}</Label>
                {login.prompt.type === 'select' && login.prompt.options ? (
                  <div className="space-y-1.5">
                    {login.prompt.options.map((opt) => (
                      <Button
                        key={opt.id}
                        type="button"
                        variant="outline"
                        size="sm"
                        className="w-full justify-start"
                        onClick={() => void answerPrompt(opt.id)}
                      >
                        {opt.label}
                      </Button>
                    ))}
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <Input
                      value={promptAnswer}
                      onChange={(e) => setPromptAnswer(e.target.value)}
                      className="h-9"
                      placeholder={login.prompt.placeholder}
                    />
                    <Button type="button" size="sm" onClick={() => void answerPrompt(promptAnswer)} disabled={!promptAnswer.trim()}>
                      提交
                    </Button>
                  </div>
                )}
              </div>
            )}

            {/* 登录成功后选模型并启用 */}
            {login.status === 'done' && (
              <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
                <div className="min-w-0 flex-1">
                  <Label htmlFor="plan-model" className="mb-1.5 text-xs text-muted-foreground">
                    模型
                  </Label>
                  {planModels.length > 0 ? (
                    <select
                      id="plan-model"
                      value={selectedModel}
                      onChange={(e) => setSelectedModel(e.target.value)}
                      className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm"
                    >
                      {planModels.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name || m.id}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <Input
                      value={selectedModel}
                      onChange={(e) => setSelectedModel(e.target.value)}
                      className="h-9"
                      placeholder="模型 ID（列表为空时手动填写）"
                    />
                  )}
                </div>
                <Button type="button" size="sm" onClick={() => void activatePlan()} disabled={activating || !selectedModel}>
                  {activating ? <Loader2 className="size-3.5 animate-spin" /> : null}
                  启用该套餐
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </Section>
  );
}
