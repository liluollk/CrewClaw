import { create } from 'zustand';
import { api } from '../api/client';
import type { Persona } from '../types';

interface PersonaState {
  /** 当前工作区绑定的 Agent 身份名（如"养殖场健康管理助手"），加载失败时回退默认值 */
  name: string;
  loaded: boolean;
  load: () => Promise<void>;
  reset: () => void;
}

export const DEFAULT_AGENT_NAME = '健康管理助手';

export const usePersonaStore = create<PersonaState>((set) => ({
  name: DEFAULT_AGENT_NAME,
  loaded: false,
  load: async () => {
    try {
      const persona = await api.get<Persona>('/api/persona');
      if (persona?.name) set({ name: persona.name, loaded: true });
    } catch {
      /* 未登录或网络失败：保留默认名，不打断界面 */
    }
  },
  reset: () => set({ name: DEFAULT_AGENT_NAME, loaded: false }),
}));
