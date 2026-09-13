/**
 * 四段 Prompt 体系与上下文预算测试。
 *
 * 测试覆盖：
 *  1) 四段拼接顺序与空段过滤。
 *  2) 段长超限拒绝。
 *  3) 双层哈希：改正文→两哈希都变；改元数据→仅计划哈希变。
 *  4) Token 估算中文样例正确。
 *  5) 预算防线：50K 告警 / 100K 抛错。
 *  6) 必填段校验。
 */
import { describe, expect, it } from 'vitest';
import {
  buildAgentProfilePrompt,
  buildProfilePromptFromFields,
  validateSegments,
  estimatePromptTokens,
  checkPromptBudget,
  sha256,
  MAX_SEGMENT_LENGTH,
  TOKEN_WARN_THRESHOLD,
  TOKEN_ERROR_THRESHOLD,
} from '../src/agent/prompt.js';

describe('P3 · 四段校验', () => {
  it('完整四段通过校验', () => {
    const errors = validateSegments({
      identity: '你是一个助手',
      soul: '你温柔耐心',
      agents: '按工作流回复',
      tools: '可用工具：query_pen_metrics',
    });
    expect(errors).toEqual([]);
  });

  it('仅必填段通过校验', () => {
    const errors = validateSegments({
      identity: '你是一个助手',
      agents: '按工作流回复',
    });
    expect(errors).toEqual([]);
  });

  it('IDENTITY 为空时报错', () => {
    const errors = validateSegments({
      identity: '',
      agents: '按工作流回复',
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('IDENTITY');
  });

  it('AGENTS 为空时报错', () => {
    const errors = validateSegments({
      identity: '你是一个助手',
      agents: '',
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('AGENTS');
  });

  it('段长超限时报错', () => {
    const longText = 'a'.repeat(MAX_SEGMENT_LENGTH + 1);
    const errors = validateSegments({
      identity: longText,
      agents: 'agents',
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some(e => e.includes('超过'))).toBe(true);
  });
});

describe('P3 · 拼装顺序与空段过滤', () => {
  it('固定顺序 IDENTITY→SOUL→AGENTS→TOOLS', () => {
    const result = buildAgentProfilePrompt({
      identity: 'ID',
      soul: 'SOUL',
      agents: 'AG',
      tools: 'TOOLS',
    });
    // 段间用 \n\n 分隔，每段占 2 行（标题+内容）
    const lines = result.fullPrompt.split('\n');
    expect(lines[0]).toBe('## IDENTITY');
    expect(lines[3]).toBe('## SOUL');
    expect(lines[6]).toBe('## AGENTS');
    expect(lines[9]).toBe('## TOOLS');
  });

  it('空段被跳过', () => {
    const result = buildAgentProfilePrompt({
      identity: 'ID',
      soul: '',
      agents: 'AG',
      tools: '',
    });
    expect(result.fullPrompt).not.toContain('## SOUL');
    expect(result.fullPrompt).not.toContain('## TOOLS');
    expect(result.fullPrompt).toContain('## IDENTITY');
    expect(result.fullPrompt).toContain('## AGENTS');
  });

  it('仅有必填段也能正常拼装', () => {
    const result = buildAgentProfilePrompt({
      identity: 'ID',
      agents: 'AG',
    });
    expect(result.fullPrompt).toContain('## IDENTITY');
    expect(result.fullPrompt).toContain('## AGENTS');
    expect(result.fullPrompt).not.toContain('## SOUL');
  });
});

describe('P3 · 双层哈希', () => {
  it('改正文→两哈希都变', () => {
    const a = buildAgentProfilePrompt({
      identity: '初始身份',
      soul: '初始灵魂',
      agents: '初始工作流',
      tools: '初始工具',
    });
    const b = buildAgentProfilePrompt({
      identity: '新版身份', // 改了
      soul: '初始灵魂',
      agents: '初始工作流',
      tools: '初始工具',
    });
    // 所有段哈希都不同（因为 IDENTITY 变了）
    expect(a.segmentHashes[0].hash).not.toBe(b.segmentHashes[0].hash);
    // 计划哈希也不同
    expect(a.planHash).not.toBe(b.planHash);
  });

  it('相同输入确定性输出（相同内容两次调用结果一致）', () => {
    const a = buildAgentProfilePrompt({
      identity: '身份',
      agents: '工作流',
    });
    const b = buildAgentProfilePrompt({
      identity: '身份',
      agents: '工作流',
    });
    expect(a.planHash).toBe(b.planHash);
    expect(a.segmentHashes[0].hash).toBe(b.segmentHashes[0].hash);
  });

  it('块级哈希与段内容一一对应', () => {
    const result = buildAgentProfilePrompt({
      identity: '你好',
      agents: '请回复',
    });
    expect(result.segmentHashes.length).toBe(2);
    expect(result.segmentHashes[0].segment).toBe('IDENTITY');
    expect(result.segmentHashes[1].segment).toBe('AGENTS');
    expect(result.segmentHashes[0].hash).toBe(sha256('你好'));
    expect(result.segmentHashes[1].hash).toBe(sha256('请回复'));
  });

  it('计划级哈希覆盖整份文本', () => {
    const result = buildAgentProfilePrompt({
      identity: 'ID',
      soul: 'SOUL',
      agents: 'AG',
      tools: 'TOOLS',
    });
    expect(result.planHash).toBe(sha256(result.fullPrompt));
  });
});

describe('P3 · Token 估算', () => {
  it('空文本返回 0', () => {
    expect(estimatePromptTokens('')).toBe(0);
  });

  it('ASCII 文本按字节÷4 估算', () => {
    // 16 个 ASCII 字符 → 16 字节 ÷ 4 = 4
    expect(estimatePromptTokens('abcdefghijklmnop')).toBe(4);
  });

  it('中文文本按非ASCII字符数估算（防中文低估）', () => {
    // 4 个中文字 → 12 字节，max(12÷4=3, 4) = 4
    expect(estimatePromptTokens('你好世界')).toBe(4);
  });

  it('混合文本取较大值', () => {
    // "你好" 6 字节 + "abc" 3 字节 = 9 字节，max(9÷4=2.25→3, 2) = 3
    expect(estimatePromptTokens('你好abc')).toBe(3);
  });

  it('长文本估算', () => {
    // 1000 个中文字 → 3000 字节，max(3000÷4=750, 1000) = 1000
    const chinese = '中'.repeat(1000);
    expect(estimatePromptTokens(chinese)).toBe(1000);
  });
});

describe('P3 · 上下文预算防线', () => {
  it('正常文本不告警', () => {
    const result = checkPromptBudget('你好');
    expect(result.allowed).toBe(true);
    expect(result.warn).toBe(false);
    expect(result.error).toBe(false);
  });

  it('超过 50K 告警但不阻断', () => {
    // 制造约 60K tokens 的文本
    // 用中文，每个字约 1 token
    const text = '中'.repeat(TOKEN_WARN_THRESHOLD + 5000);
    const result = checkPromptBudget(text);
    expect(result.allowed).toBe(true);
    expect(result.warn).toBe(true);
    expect(result.error).toBe(false);
  });

  it('超过 100K 拒绝执行', () => {
    const text = '中'.repeat(TOKEN_ERROR_THRESHOLD + 5000);
    const result = checkPromptBudget(text);
    expect(result.allowed).toBe(false);
    expect(result.warn).toBe(true);
    expect(result.error).toBe(true);
  });
});

describe('P3 · buildProfilePromptFromFields', () => {
  it('从 AgentProfile 字段构建', () => {
    const result = buildProfilePromptFromFields({
      identityPrompt: '你是一个助手',
      agentsPrompt: '按工作流回复',
    });
    expect(result.fullPrompt).toContain('## IDENTITY');
    expect(result.fullPrompt).toContain('## AGENTS');
    expect(result.segmentHashes.length).toBe(2);
  });

  it('包含所有四段', () => {
    const result = buildProfilePromptFromFields({
      identityPrompt: 'ID',
      soulPrompt: 'SOUL',
      agentsPrompt: 'AG',
      toolsPrompt: 'TOOLS',
    });
    expect(result.segmentHashes.length).toBe(4);
  });
});

describe('P3 · 集成：buildAgentProfilePrompt 完整输出', () => {
  it('完整输出格式正确', () => {
    const result = buildAgentProfilePrompt({
      identity: '你是 Miniclaw 助手，负责回答用户问题。',
      soul: '你温柔耐心，用中文回复。',
      agents: '1. 理解用户意图\n2. 查询必要信息\n3. 给出回答',
      tools: '可用工具：query_pen_metrics(penId: 猪舍编号)',
    });
    // 包含所有段标题
    expect(result.fullPrompt).toContain('## IDENTITY');
    expect(result.fullPrompt).toContain('## SOUL');
    expect(result.fullPrompt).toContain('## AGENTS');
    expect(result.fullPrompt).toContain('## TOOLS');
    // 包含段内容
    expect(result.fullPrompt).toContain('你是 Miniclaw 助手');
    expect(result.fullPrompt).toContain('你温柔耐心');
    expect(result.fullPrompt).toContain('理解用户意图');
    expect(result.fullPrompt).toContain('query_pen_metrics');
    // 有哈希和估算
    expect(result.segmentHashes.length).toBe(4);
    expect(result.planHash.length).toBe(64);
    expect(result.estimatedTokens).toBeGreaterThan(0);
  });
});