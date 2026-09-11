import { useEffect } from 'react';
import { ChatView } from '../components/chat/ChatView';
import { useChatStore } from '../stores/chat';
import { useWorkspaceStore } from '../stores/workspace';
import { usePersonaStore } from '../stores/persona';

/** /chat 页面壳：进入时刷新工作区与身份信息（侧栏、头部、气泡名消费） */
export function ChatPage() {
  const loadWorkspaces = useWorkspaceStore((s) => s.load);
  const loadPersona = usePersonaStore((s) => s.load);
  const resetChat = useChatStore((s) => s.reset);
  const resetPersona = usePersonaStore((s) => s.reset);

  useEffect(() => {
    void loadWorkspaces();
    void loadPersona();
    return () => {
      resetChat();
      resetPersona();
    };
  }, [loadWorkspaces, loadPersona, resetChat, resetPersona]);

  return <ChatView />;
}
