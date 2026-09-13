/**
 * 模型接入配置测试（Pi 原生 models.json / auth.json 文件方案）：
 * env 回退、文件覆盖、密钥沿用、校验拒绝、其他 provider 保留、上游探测。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  getProviderConfig,
  saveProviderConfig,
  probeProvider,
  ProviderConfigError,
} from '../src/agent/provider-config.js';

describe('模型接入配置（Pi 原生文件）', () => {
  let agentDir: string;
  const envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniclaw-provider-test-'));
    for (const key of ['MINICLAW_BASE_URL', 'MINICLAW_API_KEY', 'MINICLAW_MODEL']) {
      envBackup[key] = process.env[key];
    }
    process.env.MINICLAW_BASE_URL = 'https://env.example.com/v1';
    process.env.MINICLAW_API_KEY = 'env-key';
    process.env.MINICLAW_MODEL = 'env-model';
  });

  afterEach(() => {
    fs.rmSync(agentDir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('无配置文件时回退到环境变量并标记 source=env', () => {
    const cfg = getProviderConfig(undefined, agentDir);
    expect(cfg).toMatchObject({
      baseUrl: 'https://env.example.com/v1',
      apiKey: 'env-key',
      modelId: 'env-model',
      source: 'env',
      version: 0,
    });
  });

  it('保存后写入 models.json + auth.json，读取走文件且密钥不进 models.json', () => {
    saveProviderConfig(undefined, agentDir, {
      baseUrl: 'https://farm.example.com/v1/',
      modelId: 'deepseek-v4.1-flash',
      apiKey: 'farm-key',
    });
    const cfg = getProviderConfig(undefined, agentDir);
    expect(cfg).toMatchObject({
      baseUrl: 'https://farm.example.com/v1',
      modelId: 'deepseek-v4.1-flash',
      apiKey: 'farm-key',
      source: 'file',
    });
    expect(cfg.version).toBeGreaterThan(0);

    const modelsRaw = fs.readFileSync(path.join(agentDir, 'models.json'), 'utf8');
    expect(modelsRaw).toContain('farm.example.com');
    expect(modelsRaw).not.toContain('farm-key'); // 密钥只进 auth.json
    const auth = JSON.parse(fs.readFileSync(path.join(agentDir, 'auth.json'), 'utf8'));
    expect(auth.custom).toMatchObject({ type: 'api_key', key: 'farm-key' });
  });

  it('更新时留空 apiKey 沿用旧密钥，并保留既有模型条目', () => {
    saveProviderConfig(undefined, agentDir, {
      baseUrl: 'https://a.com/v1',
      modelId: 'm1',
      apiKey: 'secret-1',
    });
    saveProviderConfig(undefined, agentDir, {
      baseUrl: 'https://b.com/v1',
      modelId: 'm2',
      apiKey: '',
    });
    const cfg = getProviderConfig(undefined, agentDir);
    expect(cfg.baseUrl).toBe('https://b.com/v1');
    expect(cfg.modelId).toBe('m2');
    expect(cfg.apiKey).toBe('secret-1');
  });

  it('保存时保留 models.json 里其他 provider 与注释外字段', () => {
    fs.writeFileSync(
      path.join(agentDir, 'models.json'),
      JSON.stringify({
        providers: {
          other: { baseUrl: 'https://other.com/v1', models: [{ id: 'x' }] },
        },
        customTopLevel: true,
      }),
    );
    saveProviderConfig(undefined, agentDir, {
      baseUrl: 'https://custom.site/v1',
      modelId: 'deepseek-v4.1-flash',
      apiKey: 'k',
    });
    const parsed = JSON.parse(fs.readFileSync(path.join(agentDir, 'models.json'), 'utf8'));
    expect(parsed.providers.other.baseUrl).toBe('https://other.com/v1');
    expect(parsed.customTopLevel).toBe(true);
    expect(parsed.providers.custom.baseUrl).toBe('https://custom.site/v1');
  });

  it('首次配置缺 apiKey、非法 baseUrl、空 modelId 都被拒绝', () => {
    expect(() =>
      saveProviderConfig(undefined, agentDir, { baseUrl: 'https://a.com/v1', modelId: 'm1', apiKey: '' }),
    ).toThrow(ProviderConfigError);
    expect(() =>
      saveProviderConfig(undefined, agentDir, { baseUrl: 'not-a-url', modelId: 'm1', apiKey: 'k' }),
    ).toThrow(ProviderConfigError);
    expect(() =>
      saveProviderConfig(undefined, agentDir, { baseUrl: 'https://a.com/v1', modelId: '  ', apiKey: 'k' }),
    ).toThrow(ProviderConfigError);
    expect(getProviderConfig(undefined, agentDir).source).toBe('env');
  });

  it('probeProvider 把上游错误状态与信息原样带回', async () => {
    const ok = await probeProvider(
      { baseUrl: 'https://api.test/v1', apiKey: 'k', modelId: 'm' },
      (async () => new Response(JSON.stringify({ choices: [] }), { status: 200 })) as typeof fetch,
    );
    expect(ok).toMatchObject({ ok: true, status: 200 });

    const denied = await probeProvider(
      { baseUrl: 'https://api.test/v1', apiKey: 'k', modelId: 'm' },
      (async () =>
        new Response(JSON.stringify({ code: 'SUBSCRIPTION_NOT_FOUND', message: 'No active subscription' }), {
          status: 403,
        })) as typeof fetch,
    );
    expect(denied).toMatchObject({
      ok: false,
      status: 403,
      message: 'No active subscription',
    });
  });
});
