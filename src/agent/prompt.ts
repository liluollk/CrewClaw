/**
 * 四段 Prompt 体系与上下文预算。
 *
 * 设计要点：
 *  - 四段契约：IDENTITY/SOUL/AGENTS/TOOLS，每段 ≤20K 字符。
 *  - IDENTITY 与 AGENTS 必填，SOUL 与 TOOLS 可选。
 *  - 拼装管线：固定顺序 IDENTITY→SOUL→AGENTS→TOOLS，跳过空段，Markdown 格式。
 *  - 双层哈希：块级 SHA-256 追踪单段漂移 + 计划级 SHA-256 追踪整份装配结果。
 *  - 上下文预算：max(字节÷4, 非ASCII码点数) 防中文低估 + 50K warn / 100K 抛错。
 *  - 安全底线：不覆盖平台运行时指令（Pi 的 security/系统提示词始终在场）。
 */
import crypto from 'node:crypto';

// ── 常量 ──────────────────────────────────────────────────────────────

/** 每段最大字符数 */
export const MAX_SEGMENT_LENGTH = 20_000;

/** Token 估算告警阈值 */
export const TOKEN_WARN_THRESHOLD = 50_000;

/** Token 估算错误阈值 */
export const TOKEN_ERROR_THRESHOLD = 100_000;

/** 段名枚举 */
export type SegmentName = 'IDENTITY' | 'SOUL' | 'AGENTS' | 'TOOLS';

/** 段顺序（固定） */
const SEGMENT_ORDER: SegmentName[] = ['IDENTITY', 'SOUL', 'AGENTS', 'TOOLS'];

// ── 类型 ──────────────────────────────────────────────────────────────

export interface FourSegmentPrompt {
  identity: string;
  soul?: string;
  agents: string;
  tools?: string;
}

export interface SegmentHash {
  /** 段名 */
  segment: SegmentName;
  /** 段内容 SHA-256 */
  hash: string;
  /** 段字符长度 */
  length: number;
}

/** 段名到 FourSegmentPrompt 字段名的映射 */
const SEGMENT_FIELD_MAP: Record<SegmentName, keyof FourSegmentPrompt> = {
  IDENTITY: 'identity',
  SOUL: 'soul',
  AGENTS: 'agents',
  TOOLS: 'tools',
};

export interface PromptAssemblyResult {
  /** 完整拼装后的 Markdown 文本 */
  fullPrompt: string;
  /** 块级哈希（每段一个） */
  segmentHashes: SegmentHash[];
  /** 计划级哈希（整份装配结果） */
  planHash: string;
  /** 估算 token 数 */
  estimatedTokens: number;
  /** 是否超过告警阈值 */
  warn: boolean;
  /** 是否超过错误阈值（此时应拒绝执行） */
  error: boolean;
}

// ── 校验 ──────────────────────────────────────────────────────────────

/** 校验四段输入，返回错误信息数组（空 = 无错误） */
export function validateSegments(seg: FourSegmentPrompt): string[] {
  const errors: string[] = [];
  if (!seg.identity || seg.identity.trim().length === 0) {
    errors.push('IDENTITY 段必填');
  }
  if (!seg.agents || seg.agents.trim().length === 0) {
    errors.push('AGENTS 段必填');
  }
  if (seg.identity && seg.identity.length > MAX_SEGMENT_LENGTH) {
    errors.push(`IDENTITY 段超过 ${MAX_SEGMENT_LENGTH} 字符限制（当前 ${seg.identity.length}）`);
  }
  if (seg.soul && seg.soul.length > MAX_SEGMENT_LENGTH) {
    errors.push(`SOUL 段超过 ${MAX_SEGMENT_LENGTH} 字符限制（当前 ${seg.soul.length}）`);
  }
  if (seg.agents && seg.agents.length > MAX_SEGMENT_LENGTH) {
    errors.push(`AGENTS 段超过 ${MAX_SEGMENT_LENGTH} 字符限制（当前 ${seg.agents.length}）`);
  }
  if (seg.tools && seg.tools.length > MAX_SEGMENT_LENGTH) {
    errors.push(`TOOLS 段超过 ${MAX_SEGMENT_LENGTH} 字符限制（当前 ${seg.tools.length}）`);
  }
  return errors;
}

// ── Token 估算 ────────────────────────────────────────────────────────

/**
 * 估算文本的 token 数。
 * 使用 max(字节÷4, 非ASCII码点数) 防止中文低估。
 * ASCII 字符按 ~1 token/4 chars，非ASCII 按 ~1 token/char。
 */
export function estimatePromptTokens(text: string): number {
  if (!text) return 0;
  const byteCount = new TextEncoder().encode(text).length;
  let nonAsciiCount = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) {
      nonAsciiCount++;
    }
  }
  return Math.max(Math.ceil(byteCount / 4), nonAsciiCount);
}

// ── 哈希 ──────────────────────────────────────────────────────────────

/** 计算字符串的 SHA-256 哈希 */
export function sha256(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

// ── 拼装管线 ──────────────────────────────────────────────────────────

/**
 * 构建四段 Agent Profile Prompt。
 * 固定顺序 IDENTITY→SOUL→AGENTS→TOOLS，跳过空段，Markdown 格式。
 */
export function buildAgentProfilePrompt(seg: FourSegmentPrompt): PromptAssemblyResult {
  const errors = validateSegments(seg);
  if (errors.length > 0) {
    throw new Error(`四段校验失败：${errors.join('；')}`);
  }

  const segmentHashes: SegmentHash[] = [];
  const parts: string[] = [];

  for (const name of SEGMENT_ORDER) {
    const field = SEGMENT_FIELD_MAP[name];
    const content = (seg[field] as string | undefined) ?? '';
    if (!content || content.trim().length === 0) continue;

    // 块级哈希
    const hash = sha256(content);
    segmentHashes.push({ segment: name, hash, length: content.length });

    // Markdown 格式装配
    parts.push(`## ${name}\n${content}`);
  }

  const fullPrompt = parts.join('\n\n');
  const estimatedTokens = estimatePromptTokens(fullPrompt);

  // 计划级哈希
  const planHash = sha256(fullPrompt);

  return {
    fullPrompt,
    segmentHashes,
    planHash,
    estimatedTokens,
    warn: estimatedTokens > TOKEN_WARN_THRESHOLD,
    error: estimatedTokens > TOKEN_ERROR_THRESHOLD,
  };
}

// ── 从 AgentProfile 构建 ─────────────────────────────────────────────

/**
 * 从 AgentProfile 的提示字段构建四段 prompt。
 * 各字段分别映射到对应段。
 */
export function buildProfilePromptFromFields(fields: {
  identityPrompt: string;
  soulPrompt?: string;
  agentsPrompt: string;
  toolsPrompt?: string;
}): PromptAssemblyResult {
  return buildAgentProfilePrompt({
    identity: fields.identityPrompt,
    soul: fields.soulPrompt,
    agents: fields.agentsPrompt,
    tools: fields.toolsPrompt,
  });
}

// ── 预算防线 ──────────────────────────────────────────────────────────

export interface BudgetCheckResult {
  allowed: boolean;
  estimatedTokens: number;
  warn: boolean;
  error: boolean;
  message: string;
}

/**
 * 预检上下文预算。
 * 50K 告警（不阻断），100K 抛错（阻断）。
 */
export function checkPromptBudget(fullPrompt: string): BudgetCheckResult {
  const estimatedTokens = estimatePromptTokens(fullPrompt);
  if (estimatedTokens > TOKEN_ERROR_THRESHOLD) {
    return {
      allowed: false,
      estimatedTokens,
      warn: true,
      error: true,
      message: `上下文预算超限：估算 ${estimatedTokens} tokens，超过错误阈值 ${TOKEN_ERROR_THRESHOLD}，拒绝执行`,
    };
  }
  if (estimatedTokens > TOKEN_WARN_THRESHOLD) {
    return {
      allowed: true,
      estimatedTokens,
      warn: true,
      error: false,
      message: `上下文预算告警：估算 ${estimatedTokens} tokens，超过告警阈值 ${TOKEN_WARN_THRESHOLD}`,
    };
  }
  return {
    allowed: true,
    estimatedTokens,
    warn: false,
    error: false,
    message: `上下文预算正常：估算 ${estimatedTokens} tokens`,
  };
}