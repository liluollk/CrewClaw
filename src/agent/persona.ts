/**
 * 集成桥 · 身份装配：Profile（DB）→ 四段 Prompt（prompt.ts 拼装）→ 注入 Pi。
 *
 * 这是身份模型与 Prompt 体系的交汇：identity_hash 的输入（四段提示词）
 * 正是拼装系统提示词的原料——同一份数据，两处使用。
 */
import { getAgentProfile } from '../core/models.js';
import type { DatabaseType } from '../core/database.js';
import { buildProfilePromptFromFields, type PromptAssemblyResult } from './prompt.js';

export interface PersonaPrompt extends PromptAssemblyResult {
  profileId: string;
  version: number;
  identityHash: string;
}

/**
 * 按 profileId 从库中加载 AgentProfile，拼装四段身份提示词。
 * 找不到 profile 时抛错（fail-fast，避免静默用错误身份对话）。
 */
export function buildPersonaPrompt(
  db: DatabaseType | undefined,
  profileId: string,
): PersonaPrompt {
  const profile = getAgentProfile(db, profileId);
  if (!profile) {
    throw new Error(`AgentProfile 不存在: ${profileId}，无法装配身份`);
  }
  const assembled = buildProfilePromptFromFields({
    identityPrompt: profile.identityPrompt,
    soulPrompt: profile.soulPrompt,
    agentsPrompt: profile.agentsPrompt,
    toolsPrompt: profile.toolsPrompt,
  });
  return {
    ...assembled,
    profileId: profile.id,
    version: profile.version,
    identityHash: profile.identityHash,
  };
}