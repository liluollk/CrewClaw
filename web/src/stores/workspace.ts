import { create } from 'zustand';
import { api } from '../api/client';
import type { WorkspaceInfo } from '../types';

interface WorkspaceState {
  workspaces: WorkspaceInfo[];
  loaded: boolean;
  load: () => Promise<void>;
  select: (id: string) => Promise<void>;
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  workspaces: [],
  loaded: false,
  load: async () => {
    const rows = await api.get<WorkspaceInfo[]>('/api/workspaces');
    set({ workspaces: rows, loaded: true });
  },
  select: async (id) => {
    await api.post(`/api/workspaces/${id}/select`);
    // 切换工作区后整页刷新：会话/记忆/任务全部随 workspace 上下文变化
    window.location.assign('/chat');
  },
}));
