import { useEffect, useState } from 'react';
import { useChatStore } from '../../stores/chat';
import { useWorkspaceStore } from '../../stores/workspace';
import { usePersonaStore } from '../../stores/persona';
import { MessageList } from './MessageList';
import { MessageInput } from './MessageInput';
import { ConfirmDialog } from '../common/ConfirmDialog';

/**
 * 工作台主视图：单会话聊天（无会话侧栏/文件/终端面板）。
 */
export function ChatView() {
  const messages = useChatStore((s) => s.messages);
  const loaded = useChatStore((s) => s.loaded);
  const streaming = useChatStore((s) => s.streaming);
  const loadHistory = useChatStore((s) => s.loadHistory);
  const sendText = useChatStore((s) => s.sendText);
  const confirm = useChatStore((s) => s.confirm);
  const workspaceName = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.active)?.name,
  );
  const agentName = usePersonaStore((s) => s.name);
  const [confirmLoading, setConfirmLoading] = useState(false);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  const handleConfirm = async (approve: boolean) => {
    if (!streaming.confirmRequest) return;
    setConfirmLoading(true);
    try {
      await confirm(streaming.confirmRequest.id, approve);
    } finally {
      setConfirmLoading(false);
    }
  };

  return (
    <div
      data-hc-chat-view
      className="h-full flex flex-col bg-surface dark:bg-background"
    >
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-4 max-lg:px-4 max-lg:py-2.5 max-lg:bg-background/60 max-lg:backdrop-blur-xl max-lg:saturate-[1.8] max-lg:border-border/40">
        <div className="flex-1 min-w-0">
          <h2 className="font-semibold text-foreground text-[15px] truncate">
            {workspaceName ?? '工作台'}
          </h2>
          <div className="flex min-w-0 items-center gap-1.5 overflow-hidden text-xs text-muted-foreground">
            <span className="truncate">{agentName}</span>
          </div>
        </div>
        {streaming.active && (
          <span className="hidden h-8 shrink-0 items-center gap-1.5 rounded-md bg-emerald-50 px-2.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300 sm:inline-flex">
            <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" />
            运行中
          </span>
        )}
      </div>

      {/* Main canvas */}
      <div className="flex-1 flex flex-col overflow-hidden min-h-0">
        <MessageList
          messages={messages}
          loading={!loaded}
          hasMore={false}
          onLoadMore={() => {}}
          scrollTrigger={messages.length}
          isWaiting={streaming.active}
          onSend={async (content) => {
            await sendText(content);
          }}
        />
        <MessageInput
          placeholder="输入消息，如：查一下 A3 猪舍的指标"
          onSend={async (content) => {
            await sendText(content);
            return true;
          }}
          disabled={streaming.active}
          isRunning={streaming.active}
        />
      </div>

      {/* 写操作确认卡 */}
      {streaming.confirmRequest && (
        <ConfirmDialog
          open
          title={`允许调用工具 ${streaming.confirmRequest.tool}？`}
          message={streaming.confirmRequest.summary || '该工具将执行写操作，请确认。'}
          confirmText="批准"
          cancelText="拒绝"
          loading={confirmLoading}
          onClose={() => handleConfirm(false)}
          onConfirm={() => handleConfirm(true)}
        />
      )}
    </div>
  );
}
