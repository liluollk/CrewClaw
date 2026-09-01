/**
 * 渠道抽象契约（IMChannel）与复合会话寻址（渠道 + 账号 + 对话 + 话题）。
 *
 * 设计要点：
 *  - IMChannel 只暴露最小操作：connect / disconnect / sendMessage / setTyping / isConnected。
 *  - 差异能力（如流式）用可选方法显式建模，不假设所有渠道功能一致。
 *  - 会话按「对话对象」归属，不按渠道归属：任何渠道进来都汇到同一个 Agent 会话入口，
 *    Web 与飞书各自独立会话（channelKey 不同），解决"Web/飞书是不是同一会话"的疑问。
 *
 * 复合会话键（多 Bot 并存）：
 *  - 单账号单话题时退化为旧格式 channel:<kind>:<convId>，历史会话数据零迁移。
 *  - 引入账号/话题维度后规范形为
 *      channel:<kind>[#account:<a>]#conv:<c>[#thread:<t>]
 *    解决"同一平台挂两个 Bot，同一条群消息分不清是谁的会话"的串扰问题。
 *  - build/parse 互为逆运算（canonical 形式往返一致），是纯字符串代数，可完全离线测试。
 */
import type { StreamCallbacks } from './agent-runtime.js';

/** 渠道能力声明：区分基础(收发)与可选(流式/打字) */
export interface ChannelCapabilities {
  streaming: boolean; // 是否支持流式增量推送（飞书/Web 差异能力）
}

/** 最小渠道契约 */
export interface IMChannel {
  readonly kind: string; // e.g. 'web' | 'feishu'
  /** 账号身份（可选）：同一 kind 挂多个 Bot 时用于区分实例与寻址；缺省 = 单账号 */
  readonly accountId?: string;
  readonly capabilities: ChannelCapabilities;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  /** 发一条完整消息（基础能力） */
  sendMessage(conversationId: string, text: string): Promise<void>;
  /** 打字指示（基础/可选） */
  setTyping?(conversationId: string, typing: boolean): Promise<void>;
  /** 流式增量推送（可选能力，streaming=true 时可用） */
  stream?(conversationId: string, cb: StreamCallbacks): Promise<void>;
}

// ── 复合会话键 ────────────────────────────────────────────────────────

/** 会话键的结构化表示：kind 必填，conv 必填，account/thread 为可选维度 */
export interface SessionKeyParts {
  kind: string;
  accountId?: string;
  conversationId: string;
  threadId?: string;
}

const KEY_PREFIX = 'channel:';

function assertNonEmpty(value: string, label: string): void {
  if (!value || value.trim().length === 0) {
    throw new Error(`会话键非法：${label} 不能为空`);
  }
}

/**
 * 构建复合会话键（canonical 形）。
 *  - 无 account 且无 thread → 退化为旧格式 `channel:<kind>:<convId>`（向后兼容）。
 *  - kind 不允许携带分隔符（'#'/':'），保证 parse 无歧义；conversationId 允许 ':'。
 */
export function buildSessionKey(parts: SessionKeyParts): string {
  const { kind, accountId, conversationId, threadId } = parts;
  assertNonEmpty(kind, 'kind');
  assertNonEmpty(conversationId, 'conversationId');
  if (kind.includes('#') || kind.includes(':')) {
    throw new Error(`会话键非法：kind 不能包含 '#' 或 ':'（当前 "${kind}"）`);
  }
  if (accountId !== undefined) assertNonEmpty(accountId, 'accountId');
  if (threadId !== undefined) assertNonEmpty(threadId, 'threadId');

  if (!accountId && !threadId) {
    return `${KEY_PREFIX}${kind}:${conversationId}`;
  }
  let key = `${KEY_PREFIX}${kind}`;
  if (accountId) key += `#account:${accountId}`;
  key += `#conv:${conversationId}`;
  if (threadId) key += `#thread:${threadId}`;
  return key;
}

/**
 * 解析会话键（兼容旧格式与复合格式）。
 *  - 旧格式 `channel:<kind>:<rest...>`：rest 整体作为 conversationId（允许含 ':'）。
 *  - 复合格式 `channel:<kind>[#account:..][#conv:..][#thread:..]`：维度段必须齐全合法，
 *    未知维度、重复维度一律拒绝（宁可抛错也不产生第二套语义）。
 */
export function parseSessionKey(key: string): SessionKeyParts {
  if (!key.startsWith(KEY_PREFIX)) {
    throw new Error(`会话键非法：缺少 "${KEY_PREFIX}" 前缀（当前 "${key}"）`);
  }
  const body = key.slice(KEY_PREFIX.length);
  const segments = body.split('#');

  if (segments.length === 1) {
    // 旧格式：kind 取第一个 ':' 前，conversationId 取其后全部
    const idx = segments[0].indexOf(':');
    const kind = idx >= 0 ? segments[0].slice(0, idx) : '';
    const conversationId = idx >= 0 ? segments[0].slice(idx + 1) : '';
    if (!kind || !conversationId) {
      throw new Error(`会话键非法：旧格式缺少 kind 或 conversationId（当前 "${key}"）`);
    }
    return { kind, conversationId };
  }

  const kind = segments[0];
  assertNonEmpty(kind, 'kind');
  let accountId: string | undefined;
  let conversationId: string | undefined;
  let threadId: string | undefined;
  for (const seg of segments.slice(1)) {
    const idx = seg.indexOf(':');
    const dim = idx >= 0 ? seg.slice(0, idx) : '';
    const value = idx >= 0 ? seg.slice(idx + 1) : '';
    assertNonEmpty(value, `维度 ${dim || '(缺失)'}`);
    switch (dim) {
      case 'account':
        if (accountId !== undefined) throw new Error(`会话键非法：account 维度重复（"${key}"）`);
        accountId = value;
        break;
      case 'conv':
        if (conversationId !== undefined) throw new Error(`会话键非法：conv 维度重复（"${key}"）`);
        conversationId = value;
        break;
      case 'thread':
        if (threadId !== undefined) throw new Error(`会话键非法：thread 维度重复（"${key}"）`);
        threadId = value;
        break;
      default:
        throw new Error(`会话键非法：未知维度 "${dim}"（"${key}"）`);
    }
  }
  if (!conversationId) {
    throw new Error(`会话键非法：复合格式必须包含 #conv: 维度（"${key}"）`);
  }
  const parts: SessionKeyParts = { kind, conversationId };
  if (accountId !== undefined) parts.accountId = accountId;
  if (threadId !== undefined) parts.threadId = threadId;
  return parts;
}

/**
 * 会话身份键（兼容入口）：按「对话对象」归属。
 *  - Web:   channel:web:<userId>
 *  - 飞书:  channel:feishu:<chatId>
 * 需要账号/话题维度时改用 buildSessionKey({kind, accountId, conversationId, threadId})。
 */
export function sessionKeyFor(kind: string, conversationId: string): string {
  return buildSessionKey({ kind, conversationId });
}

/** 注册表内部键：kind 或 kind#account:<a>（账号维度的实例隔离） */
function managerKey(kind: string, accountId?: string): string {
  return accountId ? `${kind}#account:${accountId}` : kind;
}

/**
 * 渠道注册表：统一入口（新渠道只需实现 IMChannel + 注册）。
 *  - 同一 (kind, accountId) 重复注册视为替换（幂等重连/测试恢复友好）。
 *  - 同一 kind 的不同 accountId 实例并存，互不覆盖——修复"Map 以 kind 为键、
 *    第二个 Bot 实例顶掉第一个"的多账号冲突。
 *  - get(kind) 不带账号时：优先精确命中裸 kind；若该 kind 下有多个账号实例则返回
 *    undefined，强制调用方显式选路，避免随机挑一个 Bot 造成串扰。
 */
export class ChannelManager {
  private channels = new Map<string, IMChannel>();
  register(channel: IMChannel): void {
    this.channels.set(managerKey(channel.kind, channel.accountId), channel);
  }
  get(kind: string, accountId?: string): IMChannel | undefined {
    if (accountId !== undefined) {
      return this.channels.get(managerKey(kind, accountId));
    }
    const bare = this.channels.get(kind);
    if (bare) return bare;
    const matches = this.listByKind(kind);
    return matches.length === 1 ? matches[0] : undefined;
  }
  /** 同一渠道类型下的全部账号实例（多 Bot 枚举） */
  listByKind(kind: string): IMChannel[] {
    return [...this.channels.values()].filter((ch) => ch.kind === kind);
  }
  list(): string[] {
    return [...this.channels.keys()];
  }
}

export const channelManager = new ChannelManager();