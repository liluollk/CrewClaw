/** 后端领域类型（对齐 src/server.ts 的响应形状） */

export type WorkspaceRole = 'owner' | 'admin' | 'member';

export interface UserPublic {
  id: string;
  username: string;
  displayName: string;
}

export interface MeResponse {
  user: UserPublic;
  workspaceId: string;
  profileId: string;
  role: WorkspaceRole;
}

export interface WorkspaceInfo {
  id: string;
  name: string;
  folder: string;
  role: WorkspaceRole;
  active: boolean;
}

export interface WorkspaceMember {
  userId: string;
  username: string;
  displayName: string;
  role: WorkspaceRole;
}

export interface PersonaSegments {
  identity: string;
  soul: string;
  agents: string;
  tools: string;
}

export interface Persona {
  id: string;
  name: string;
  version: number;
  identityHash: string;
  updatedAt: string;
  segments: PersonaSegments;
}

export interface PersonaVersion {
  version: number;
  identityHash: string;
  createdAt: string;
  snapshot: PersonaSegments | null;
}

export type MemoryKind = 'fact' | 'decision' | 'lesson' | 'open_loop';

export interface MemoryItem {
  id: string;
  storeId: string;
  kind: MemoryKind;
  title: string;
  content: string;
  status: 'active' | 'deleted';
  importance: number;
  confidence: number;
  revision: number;
  scopeType: 'workspace' | 'conversation';
  scopeKey: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryVersion {
  revision: number;
  changeType: string;
  createdAt: string;
  snapshot: unknown;
}

export interface ScheduleSpec {
  type: 'interval' | 'daily' | 'once';
  minutes?: number;
  hour?: number;
  minute?: number;
  at?: string;
}

export interface ScheduledTask {
  id: string;
  workspaceId: string;
  name: string;
  prompt: string;
  schedule: ScheduleSpec | null;
  scheduleText: string;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
}

export interface TaskRun {
  id: string;
  status: string;
  resultText: string;
  startedAt: string;
  finishedAt: string | null;
}

export interface ChannelInfo {
  kind: 'feishu' | 'dingtalk';
  accountId: string;
  enabled: boolean;
  configured: boolean;
}
