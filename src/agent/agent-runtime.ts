/**
 * AgentRuntime 封装：自包含配置 + 运行时注册 provider + env key 注入 + 会话。
 *
 * 设计要点：
 *  - Pi 内核共享；但 provider 用 registerProvider() 运行时注册，而非依赖 models.json 预置存活。
 *  - key 从 .env 读，经 setRuntimeApiKey() 注入，运行时生效、不落盘到代码/配置。
 *  - 全部状态落在 agent/ 下，自包含，不影响全局 ~/.pi/ 与本地 Coding Agent。
 *
 * 踩坑点：
 *  - #4 自定义 models.json 里的 provider 不会自动成为“已注册 provider”，
 *        getRegisteredProviderIds() 为空、getModel() 返回 undefined。
 *        要在运行时用 ModelRuntime.registerProvider() 显式注册。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, '../..');

export interface AgentRuntimeOptions {
  /** 自定义接口模式：baseUrl + apiKey + modelId（经 registerProvider 动态注册） */
  baseUrl?: string;
  apiKey?: string;
  modelId?: string;
  /** 动态注册的 provider id（仅用于隔离命名） */
  providerId?: string;
  /**
   * 订阅套餐模式：直接使用 Pi 内置 provider 目录（模型目录随 SDK 静态内置，
   * 凭据从 auth.json 的 OAuth credential 解析）。给出时忽略 baseUrl/apiKey/modelId。
   */
  planModel?: { providerId: string; modelId: string };
  sessionDir?: string;
  /**
   * 会话隔离名：不同入口（web/hello/feishu/…）各用独立 session 子目录，
   * 避免所有入口共享同一「最近会话」互相污染（呼应"会话按来源隔离"设计）。
   */
  sessionName?: string;
  /** 注入的业务工具（Pi customTools） */
  customTools?: ToolDefinition[];
  /** 是否关闭 Pi 默认内置工具（read/bash/edit/write），只留 customTools（默认关闭，安全） */
  disableBuiltinTools?: boolean;
  /**
   * Agent 身份系统提示词（四段 Prompt 拼装结果，见 prompt.ts buildAgentProfilePrompt）。
   * 以 appendSystemPrompt 方式注入——追加在 Pi 平台运行时指令之后，
   * 身份塑造角色与行为，但无法覆盖平台安全规则——这是刻意的安全底线。
   */
  systemPrompt?: string;
}

export interface TurnResult {
  text: string;
  sessionId: string;
}

function textFromMessage(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (item): item is { type: 'text'; text: string } =>
        !!item &&
        typeof item === 'object' &&
        (item as { type?: unknown }).type === 'text' &&
        typeof (item as { text?: unknown }).text === 'string',
    )
    .map((item) => item.text)
    .join('');
}

/**
 * 进程内直调 Pi：共享一份 ModelRuntime/SettingsManager/身份注入，
 * 按会话名创建多个独立 AgentSession（目录级隔离 + continueRecent 续接）。
 * createPiRuntime 是"单会话"便捷入口；SessionRouter 用工厂按复合键开多会话。
 */
export interface AgentSessionHandle {
  session: {
    subscribe: (l: (e: any) => void) => () => void;
    prompt: (t: string, o?: any) => Promise<void>;
    waitForIdle?: () => Promise<void>;
    dispose?: () => void;
  };
  sessionName: string;
  dispose: () => void;
}

export interface AgentFactory {
  createSession(sessionName: string): Promise<AgentSessionHandle>;
  providerId: string;
}

export async function createAgentFactory(opts: AgentRuntimeOptions): Promise<AgentFactory> {
  const providerId = opts.providerId ?? 'crewclaw';
  const baseSessionDir = opts.sessionDir ?? path.join(PROJECT_ROOT, 'agent', 'sessions');
  const agentDir = path.join(PROJECT_ROOT, 'agent');

  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(agentDir, 'auth.json'),
    modelsPath: path.join(agentDir, 'models.json'),
    refreshOnCreate: false,
  });

  // #4: 运行时注册 provider（OpenAI 兼容），config 结构同 models.json 里 provider。
  // 仅自定义接口模式需要注册；套餐模式直接用 Pi 内置 provider 目录。
  const isPlanMode = !!opts.planModel;
  if (!isPlanMode) {
    if (!opts.baseUrl || !opts.modelId) {
      throw new Error('自定义接口模式需要 baseUrl 与 modelId');
    }
  }
  const providerConfig = {
    name: 'CrewClaw provider',
    baseUrl: opts.baseUrl ?? '',
    api: 'openai-completions' as const,
    compat: {
      supportsDeveloperRole: false, // 采坑 #1/#5：中转站不理解 developer role，只用 system
    },
    models: [
      {
        id: opts.modelId ?? '',
        name: opts.modelId ?? '',
        reasoning: false,
        // 不声明 reasoning:true——中转站的 OpenAI 兼容面按普通模型走 system role，
        // 若按推理模型声明，Pi 会强发 developer role + reasoning_effort，而该中转站不支持 → 400（踩坑 #5）
        input: ['text', 'image'] as Array<'text' | 'image'>,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1048576,
        maxTokens: 65536,
      },
    ],
  };
  const effectiveProviderId = opts.providerId ?? 'crewclaw';
  if (!isPlanMode) {
    modelRuntime.registerProvider(effectiveProviderId, providerConfig);
    await modelRuntime.setRuntimeApiKey(effectiveProviderId, opts.apiKey ?? '');
  }

  const model = isPlanMode
    ? modelRuntime.getModel(opts.planModel!.providerId, opts.planModel!.modelId)
    : modelRuntime.getModel(effectiveProviderId, opts.modelId ?? '');
  if (!model) {
    const hint = isPlanMode
      ? `套餐 ${opts.planModel!.providerId}/${opts.planModel!.modelId} 不在 Pi 内置目录或凭据未登录。请先在设置里完成套餐登录。`
      : `Pi 模型未找到: ${effectiveProviderId}/${opts.modelId}。`;
    const errs: unknown[] = [];
    const inner = modelRuntime as unknown as {
      compositionErrors?: Map<string, unknown>;
    };
    if (inner.compositionErrors) {
      for (const [, e] of inner.compositionErrors) errs.push(e);
    }
    throw new Error(
      `${hint} compositionErrors: ${errs.map((e) => String(e)).join('; ') || '(无)'}`,
    );
  }

  const settingsManager = SettingsManager.create(PROJECT_ROOT, agentDir, {
    projectTrusted: true,
  });

  // 身份注入：用 appendSystemPrompt 把四段 Prompt 追加到 Pi 平台运行时指令之后。
  // 追加（而非替换）确保平台安全规则始终在场——身份只能塑造角色，不能覆盖边界。
  let resourceLoader: DefaultResourceLoader | undefined;
  if (opts.systemPrompt) {
    resourceLoader = new DefaultResourceLoader({
      cwd: PROJECT_ROOT,
      agentDir,
      settingsManager,
      appendSystemPrompt: [opts.systemPrompt],
    });
    await resourceLoader.reload();
  }

  return {
    providerId,
    async createSession(sessionName: string): Promise<AgentSessionHandle> {
      const sessionDir = path.join(baseSessionDir, sessionName);
      const { session } = await createAgentSession({
        cwd: PROJECT_ROOT,
        agentDir,
        modelRuntime,
        model,
        // 会话持久化：continueRecent 继续该会话名下最近的会话（不存在则新建）
        sessionManager: SessionManager.continueRecent(PROJECT_ROOT, sessionDir),
        // 自动化上下文压缩：让 Pi 在上下文接近上限时自动折叠旧对话
        settingsManager,
        ...(resourceLoader ? { resourceLoader } : {}),
        ...(opts.customTools?.length ? { customTools: opts.customTools } : {}),
        ...(opts.disableBuiltinTools !== false ? { noTools: 'builtin' } : {}),
      });
      return {
        session,
        sessionName,
        dispose: () => {
          try {
            session.dispose?.();
          } catch {
            /* 忽略重复释放 */
          }
        },
      };
    },
  };
}

/** 单会话便捷入口（demo/旧调用方兼容）：工厂 + 立即建一个会话 */
export async function createPiRuntime(opts: AgentRuntimeOptions) {
  const factory = await createAgentFactory(opts);
  const handle = await factory.createSession(opts.sessionName ?? 'default');
  return { session: handle.session, providerId: factory.providerId, dispose: handle.dispose };
}

/** 发送一轮并等待 agent_end，返回 assistant 文本 */
export async function runTurn(
  session: {
    subscribe: (l: (e: any) => void) => () => void;
    prompt: (t: string, o?: any) => Promise<void>;
    waitForIdle?: () => Promise<void>;
  },
  text: string,
): Promise<TurnResult> {
  // 先等上一轮彻底 idle，避免 "Agent already processing" 冲突（连续多轮时）
  if (session.waitForIdle) {
    try {
      await session.waitForIdle();
    } catch {
      /* ignore */
    }
  }
  return new Promise((resolve, reject) => {
    let sessionId = '';
    let out = '';
    const unsub = session.subscribe((event: any) => {
      sessionId = event?.sessionId || sessionId;
      if (event?.type !== 'agent_end') return;
      unsub();
      const assistant = [...event.messages]
        .reverse()
        .find((m: any) => m?.role === 'assistant');
      out = assistant ? textFromMessage(assistant) : '';
      resolve({ text: out, sessionId }); // agent_end 一到立即 resolve，out 必已填充
    });
    session.prompt(text).catch((err: unknown) => {
      unsub();
      reject(err);
    });
    // 兜底：防止 agent_end 因异常缺失而永不平铺
    setTimeout(() => {
      unsub();
      resolve({ text: out, sessionId });
    }, 120_000);
  });
}

/** 流式事件回调（Pi message_update 事件 → text_delta/thinking/toolcall 增量映射） */
export interface StreamCallbacks {
  onDelta: (delta: string) => void;
  onThinkingDelta?: (delta: string) => void;
  onToolStart?: (name: string, args: unknown) => void;
  onToolEnd?: (name: string, result: unknown) => void;
  onDone: (fullText: string, sessionId: string) => void;
  onError?: (err: unknown) => void;
}

/**
 * 流式发送一轮：把 Pi 的 text_delta 增量实时推给 onDelta，结束时回调 onDone。
 * 这是 Web 打字机与后续渠道流式推送的基础。
 */
export function streamTurn(
  session: {
    subscribe: (l: (e: any) => void) => () => void;
    prompt: (t: string, o?: any) => Promise<void>;
    waitForIdle?: () => Promise<void>;
  },
  text: string,
  cb: StreamCallbacks,
): void {
  let sessionId = '';
  let full = '';
  // 先等上一轮彻底 idle，避免连续 prompt 冲突。
  // 注意：必须绑定 session 调用——waitForIdle 内部依赖 this（isIdle/_getIdleWaitPromise），
  // 解绑调用会抛 TypeError 并被 catch 吞掉，导致不等 idle 直接开流（并发冲突回归）。
  const waitIdle = session.waitForIdle?.bind(session);
  if (waitIdle) {
    (async () => {
      try {
        await waitIdle();
      } catch { /* ignore */ }
      startStream();
    })();
  } else {
    startStream();
  }
  function startStream() {
    const unsub = session.subscribe((event: any) => {
      sessionId = event?.sessionId || sessionId;
      if (event.type === 'message_update') {
        const u = event.assistantMessageEvent;
        if (!u) return;
        if (u.type === 'text_delta') {
          full += u.delta;
          cb.onDelta(u.delta);
        } else if (u.type === 'thinking_delta') {
          cb.onThinkingDelta?.(u.delta);
        } else if (u.type === 'toolcall_start') {
          const tool = u?.partial?.content?.find((x: any) => x?.type === 'toolCall');
          cb.onToolStart?.(tool?.name ?? '?', tool?.arguments);
        } else if (u.type === 'toolcall_end') {
          cb.onToolEnd?.(u.toolCall?.name ?? '?', u.toolCall?.arguments);
        }
        return;
      }
      if (event.type === 'agent_end') {
        unsub();
        cb.onDone(full, sessionId);
      }
    });
    session.prompt(text).catch((err: unknown) => {
      unsub();
      cb.onError?.(err);
    });
    // 兜底防悬挂
    setTimeout(() => {
      unsub();
      cb.onDone(full, sessionId);
    }, 120_000);
  }
}