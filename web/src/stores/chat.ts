import { create } from 'zustand';
import { api } from '../api/client';
import { showToast } from '../utils/toast';

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  is_from_me: boolean;
}

export interface ConfirmRequest {
  id: string;
  tool: string;
  summary: string;
  requestedBy: string | null;
}

export interface ActiveTool {
  name: string;
  startedAt: number;
}

export interface TimelineEvent {
  id: string;
  timestamp: number;
  text: string;
  kind: 'tool' | 'status' | 'permission';
}

interface StreamingState {
  active: boolean;
  partialText: string;
  thinkingText: string;
  activeTools: ActiveTool[];
  timeline: TimelineEvent[];
  confirmRequest: ConfirmRequest | null;
}

interface ChatState {
  messages: Message[];
  loaded: boolean;
  sending: boolean;
  streaming: StreamingState;
  loadHistory: () => Promise<void>;
  sendText: (text: string) => Promise<void>;
  confirm: (id: string, approve: boolean) => Promise<void>;
  reset: () => void;
}

const emptyStreaming: StreamingState = {
  active: false,
  partialText: '',
  thinkingText: '',
  activeTools: [],
  timeline: [],
  confirmRequest: null,
};

let eventSeq = 0;
const nextEventId = () => `evt-${Date.now()}-${eventSeq++}`;

function pushEvent(timeline: TimelineEvent[], text: string, kind: TimelineEvent['kind']): TimelineEvent[] {
  return [...timeline.slice(-30), { id: nextEventId(), timestamp: Date.now(), text, kind }];
}

function systemMessage(content: string): Message {
  return {
    id: `system-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role: 'system',
    content,
    timestamp: new Date().toISOString(),
    is_from_me: false,
  };
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  loaded: false,
  sending: false,
  streaming: emptyStreaming,

  loadHistory: async () => {
    const rows = await api.get<
      Array<{ id: string; role: Message['role']; content: string; createdAt: string }>
    >('/api/chat/history?limit=200');
    set({
      messages: rows.map((r) => ({
        id: r.id,
        role: r.role,
        content: r.content,
        timestamp: r.createdAt,
        is_from_me: r.role === 'user',
      })),
      loaded: true,
    });
  },

  sendText: async (text) => {
    if (get().streaming.active || get().sending) return;
    const optimistic: Message = {
      id: `local-${Date.now()}`,
      role: 'user',
      content: text,
      timestamp: new Date().toISOString(),
      is_from_me: true,
    };
    set((s) => ({
      messages: [...s.messages, optimistic],
      sending: true,
      streaming: { ...emptyStreaming, active: true },
    }));

    try {
      const res = await fetch('/api/chat/stream', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (res.status === 401) {
        window.location.replace('/login');
        return;
      }
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let ended = false;

      const handleEvent = (payload: string) => {
        let evt: Record<string, unknown>;
        try {
          evt = JSON.parse(payload);
        } catch {
          return;
        }
        const st = get().streaming;
        switch (evt.type) {
          case 'delta':
            set({ streaming: { ...st, partialText: st.partialText + String(evt.delta ?? '') } });
            break;
          case 'thinking':
            set({ streaming: { ...st, thinkingText: st.thinkingText + String(evt.delta ?? '') } });
            break;
          case 'tool_start':
            set({
              streaming: {
                ...st,
                activeTools: [
                  ...st.activeTools,
                  { name: String(evt.name ?? ''), startedAt: Date.now() },
                ],
                timeline: pushEvent(st.timeline, `调用工具 ${evt.name}`, 'tool'),
              },
            });
            break;
          case 'tool_end':
            set({
              streaming: {
                ...st,
                activeTools: st.activeTools.filter((t) => t.name !== evt.name),
                timeline: pushEvent(st.timeline, `工具 ${evt.name} 完成`, 'tool'),
              },
            });
            break;
          case 'confirm_request':
            set({
              streaming: {
                ...st,
                confirmRequest: {
                  id: String(evt.id),
                  tool: String(evt.tool),
                  summary: String(evt.summary ?? ''),
                  requestedBy: (evt.requestedBy as string) ?? null,
                },
              },
            });
            break;
          case 'done': {
            ended = true;
            const full = String(evt.full ?? '');
            set((s) => ({
              streaming: { ...emptyStreaming },
              messages: [
                ...s.messages,
                {
                  id: `assistant-${Date.now()}`,
                  role: 'assistant' as const,
                  content: full,
                  timestamp: new Date().toISOString(),
                  is_from_me: false,
                },
              ],
            }));
            break;
          }
          case 'error':
            ended = true;
            set((s) => ({
              streaming: { ...emptyStreaming },
              messages: [...s.messages, systemMessage(`本轮处理失败：${String(evt.message ?? '')}`)],
            }));
            break;
        }
      };

      // SSE 解析：按空行分帧，取 "data: " 后的 JSON
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          for (const line of frame.split('\n')) {
            if (line.startsWith('data: ')) handleEvent(line.slice(6));
          }
        }
      }

      // 流意外中断（无 done/error 帧）：以历史收口，不留悬挂流式态
      if (!ended && get().streaming.active) {
        set({ streaming: { ...emptyStreaming } });
        await get().loadHistory();
        showToast('连接中断', '已按历史记录恢复当前会话');
      }
    } catch (err) {
      set((s) => ({
        streaming: { ...emptyStreaming },
        messages: [...s.messages, systemMessage(`发送失败：${err instanceof Error ? err.message : String(err)}`)],
      }));
    } finally {
      set({ sending: false });
    }
  },

  confirm: async (id, approve) => {
    try {
      await api.post('/api/permission/confirm', { id, approve });
      showToast(approve ? '已批准执行' : '已拒绝执行');
    } catch (err) {
      showToast('确认失败', err instanceof Error ? err.message : String(err));
    } finally {
      set((s) => ({ streaming: { ...s.streaming, confirmRequest: null } }));
    }
  },

  reset: () => set({ messages: [], loaded: false, sending: false, streaming: emptyStreaming }),
}));
