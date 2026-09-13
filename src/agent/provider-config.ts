/**
 * 模型接入配置——复用 Pi SDK 原生配置与凭据体系。
 *
 * 两种接入方式（app_settings 的 access KV 标记当前生效方式）：
 *  1. 自定义接口：agent/models.json（baseUrl/模型）+ agent/auth.json（API Key），即 Pi 原生文件；
 *  2. 订阅套餐：modelRuntime.login(planId, 'oauth', interaction) 走 Pi 内置 OAuth 流程
 *     （Claude Pro/Max、Codex、Copilot、Kimi、OpenRouter、xAI），凭据由 SDK 写入 auth.json。
 *
 * Pi 的 ModelRuntime.create({ authPath, modelsPath }) 启动时读取：
 *  - agent/models.json：provider 定义（baseUrl / api / models），支持 JSONC 注释
 *  - agent/auth.json ：凭据（{ [providerId]: { type: 'api_key', key } }），已被 gitignore
 *
 * 本模块只做三件事：
 *  1. 读写这两个文件（保存时合并、不破坏其他 provider 与注释外字段）；
 *  2. 读取生效配置（文件缺省时回退 .env，source 标明来源）；
 *  3. 探测上游连通性（绕过 Pi 的静默吞错，把 HTTP 状态/错误原样带回）。
 *
 * 运行时缓存失效：version = 两个文件的 mtime 最大值，文件一变 server.getRuntime 即重建。
 * 边界：apiKey 只写 auth.json（已 gitignore），绝不写入被 git 跟踪的 models.json。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Database as DatabaseType } from 'better-sqlite3';

const PROVIDER_ID = 'custom';
const MODELS_FILE = 'models.json';
const AUTH_FILE = 'auth.json';

export class ProviderConfigError extends Error {}

export interface ProviderConfigInput {
  baseUrl: string;
  modelId: string;
  /** 留空表示沿用已保存的密钥；首次配置必须提供 */
  apiKey?: string;
}

export interface EffectiveProviderConfig {
  baseUrl: string;
  apiKey: string;
  modelId: string;
  providerId: typeof PROVIDER_ID;
  source: 'file' | 'env';
  version: number;
}

interface ModelEntry {
  id: string;
  name?: string;
  [key: string]: unknown;
}

interface ProviderEntry {
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  models?: ModelEntry[];
  [key: string]: unknown;
}

interface ModelsFile {
  providers?: Record<string, ProviderEntry>;
  [key: string]: unknown;
}

/** 解析 models.json（容忍 # 与 // 整行注释——Pi 的样板文件带注释） */
function parseModelsFile(raw: string): ModelsFile {
  const stripped = raw
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !(t.startsWith('#') || t.startsWith('//'));
    })
    .join('\n');
  return JSON.parse(stripped) as ModelsFile;
}

function readModelsFile(agentDir: string): ModelsFile {
  try {
    return parseModelsFile(fs.readFileSync(path.join(agentDir, MODELS_FILE), 'utf8'));
  } catch {
    return {};
  }
}

function readAuthKey(agentDir: string, providerId: string): string {
  try {
    const raw = fs.readFileSync(path.join(agentDir, AUTH_FILE), 'utf8');
    const data = JSON.parse(raw) as Record<string, { type?: string; key?: string }>;
    const cred = data[providerId];
    return cred?.type === 'api_key' && typeof cred.key === 'string' ? cred.key : '';
  } catch {
    return '';
  }
}

function fileVersion(agentDir: string): number {
  let v = 0;
  for (const f of [MODELS_FILE, AUTH_FILE]) {
    try {
      v = Math.max(v, fs.statSync(path.join(agentDir, f)).mtimeMs);
    } catch {
      /* 文件不存在忽略 */
    }
  }
  return Math.round(v);
}

/**
 * 读取生效配置：agent 文件优先，缺省回退 .env（version=0 表示环境变量来源）。
 * db 参数仅为兼容旧签名占位——本实现不依赖数据库。
 */
export function getProviderConfig(
  db: DatabaseType | undefined,
  agentDir: string,
): EffectiveProviderConfig {
  void db;
  const provider = readModelsFile(agentDir).providers?.[PROVIDER_ID];
  const fileBaseUrl = typeof provider?.baseUrl === 'string' ? provider.baseUrl : '';
  const fileModel = (provider?.models ?? []).find((m) => m.id)?.id ?? '';
  const fileKey = readAuthKey(agentDir, PROVIDER_ID) || (typeof provider?.apiKey === 'string' ? provider.apiKey : '');
  if (fileBaseUrl && fileModel && fileKey) {
    return {
      baseUrl: fileBaseUrl,
      apiKey: fileKey,
      modelId: fileModel,
      providerId: PROVIDER_ID,
      source: 'file',
      version: fileVersion(agentDir),
    };
  }
  return {
    baseUrl: process.env.MINICLAW_BASE_URL ?? '',
    apiKey: process.env.MINICLAW_API_KEY ?? '',
    modelId: process.env.MINICLAW_MODEL ?? '',
    providerId: PROVIDER_ID,
    source: 'env',
    version: 0,
  };
}

/**
 * 保存到 Pi 原生配置文件：更新 models.json 里 custom 的 baseUrl 与模型列表（保留其他
 * provider 与字段），API Key 写 auth.json（gitignored）。成功后 mtime 变化即触发运行时重建。
 */
export function saveProviderConfig(
  db: DatabaseType | undefined,
  agentDir: string,
  input: ProviderConfigInput,
): EffectiveProviderConfig {
  void db;
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, '');
  const modelId = input.modelId.trim();
  if (!/^https?:\/\/.+/.test(baseUrl)) {
    throw new ProviderConfigError('baseUrl 必须是 http(s) 地址');
  }
  if (!modelId) throw new ProviderConfigError('modelId 必填');

  fs.mkdirSync(agentDir, { recursive: true });

  const modelsPath = path.join(agentDir, MODELS_FILE);
  const current = readModelsFile(agentDir);
  const providers = current.providers ?? (current.providers = {});
  const entry: ProviderEntry = providers[PROVIDER_ID] ?? (providers[PROVIDER_ID] = {});
  entry.baseUrl = baseUrl;
  entry.api = entry.api ?? 'openai-completions';
  // apiKey 不写入 models.json（该文件被 git 跟踪）：清掉样板占位，真实密钥进 auth.json
  if (typeof entry.apiKey === 'string') delete entry.apiKey;
  const models = entry.models ?? (entry.models = []);
  const existing = models.find((m) => m.id === modelId);
  if (existing) {
    existing.name = existing.name ?? modelId;
  } else if (models.length === 0) {
    models.push({ id: modelId, name: modelId });
  } else {
    // 保留既有模型行，仅把首个条目的 id 换成新模型（Pi 取 models[0] 作为该 provider 默认）
    models[0] = { ...models[0], id: modelId, name: models[0].name ?? modelId };
  }
  fs.writeFileSync(modelsPath, JSON.stringify(current, null, 2) + '\n');

  const authPath = path.join(agentDir, AUTH_FILE);
  let auth: Record<string, { type?: string; key?: string }> = {};
  try {
    auth = JSON.parse(fs.readFileSync(authPath, 'utf8')) as typeof auth;
  } catch {
    /* 首次写入 */
  }
  const effectiveKey = input.apiKey?.trim() || readAuthKey(agentDir, PROVIDER_ID);
  if (!effectiveKey) throw new ProviderConfigError('首次配置必须提供 API Key');
  auth[PROVIDER_ID] = { type: 'api_key', key: effectiveKey };
  fs.writeFileSync(authPath, JSON.stringify(auth, null, 2) + '\n');

  return getProviderConfig(undefined, agentDir);
}

export interface ProbeResult {
  ok: boolean;
  status: number;
  message: string;
}

/** 最小连通性探测：把上游 HTTP 状态与错误信息原样带回（1 token，成本可忽略） */
export async function probeProvider(
  cfg: Pick<EffectiveProviderConfig, 'baseUrl' | 'apiKey' | 'modelId'>,
  fetchImpl: typeof fetch = fetch,
): Promise<ProbeResult> {
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.modelId,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
      }),
    });
    if (res.ok) return { ok: true, status: res.status, message: '连接正常，模型可用' };
    const body: unknown = await res.json().catch(() => null);
    let message = res.statusText || `HTTP ${res.status}`;
    if (body && typeof body === 'object') {
      const b = body as { message?: unknown; error?: unknown };
      if (typeof b.message === 'string' && b.message) message = b.message;
      else if (typeof b.error === 'string' && b.error) message = b.error;
      else if (b.error && typeof b.error === 'object' && typeof (b.error as { message?: unknown }).message === 'string') {
        message = (b.error as { message: string }).message;
      }
    }
    return { ok: false, status: res.status, message };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── 订阅套餐接入（Pi 内置 OAuth 提供方） ─────────────────────────────

export interface PlanProviderInfo {
  id: string;
  name: string;
}

/** Pi 内置 OAuth 套餐（radius 需要网关参数，暂不暴露） */
export const PLAN_PROVIDERS: PlanProviderInfo[] = [
  { id: 'anthropic', name: 'Claude Pro/Max（Anthropic 订阅）' },
  { id: 'openai-codex', name: 'OpenAI Codex / ChatGPT 订阅' },
  { id: 'github-copilot', name: 'GitHub Copilot 订阅' },
  { id: 'openrouter', name: 'OpenRouter' },
  { id: 'kimi-coding', name: 'Kimi Coding 套餐' },
  { id: 'xai', name: 'xAI / SuperGrok 订阅' },
];

/** 当前生效的接入方式（app_settings 通用 KV 标记；缺省为自定义接口） */
export type AccessConfig =
  | { mode: 'custom'; version: number }
  | { mode: 'plan'; plan: string; model: string; version: number };

const KEY_ACCESS = 'access';
const KEY_ACCESS_VERSION = 'access_version';

export function getAccessConfig(db: DatabaseType): AccessConfig {
  const row = db
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .get(KEY_ACCESS) as { value: string } | undefined;
  const vRow = db
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .get(KEY_ACCESS_VERSION) as { value: string } | undefined;
  const version = Number(vRow?.value ?? 0) || 0;
  if (!row) return { mode: 'custom', version };
  try {
    const parsed = JSON.parse(row.value) as AccessConfig;
    if (parsed.mode === 'plan' && parsed.plan && parsed.model) {
      return { mode: 'plan', plan: parsed.plan, model: parsed.model, version };
    }
  } catch {
    /* 解析失败按缺省处理 */
  }
  return { mode: 'custom', version };
}

export function saveAccessConfig(
  db: DatabaseType,
  input: { mode: 'plan'; plan: string; model: string } | { mode: 'custom' },
): AccessConfig {
  const version = Date.now();
  const value = JSON.stringify(input);
  const upsert = db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `);
  const tx = db.transaction(() => {
    upsert.run(KEY_ACCESS, value);
    upsert.run(KEY_ACCESS_VERSION, String(version));
  });
  tx();
  return input.mode === 'plan'
    ? { mode: 'plan', plan: input.plan, model: input.model, version }
    : { mode: 'custom', version };
}
