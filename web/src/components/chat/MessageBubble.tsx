import { useState, memo } from 'react';
import { Copy, Check, ChevronDown, ChevronUp } from 'lucide-react';
import { Message } from '../../stores/chat';
import { useAuthStore } from '../../stores/auth';
import { MarkdownRenderer } from './MarkdownRenderer';
import { formatThinkingDuration } from '../../utils/thinking-duration';
import { parseDbTime } from '../../utils/db-time';
import { usePersonaStore } from '../../stores/persona';
import { useDisplayMode } from '../../hooks/useDisplayMode';

interface MessageBubbleProps {
  message: Message;
  showTime: boolean;
  thinkingContent?: string;
  thinkingDurationMs?: number;
}

/** Collapsible reasoning block for AI messages */
function ReasoningBlock({
  content,
  durationMs,
}: {
  content: string;
  durationMs?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const label =
    durationMs != null && durationMs > 0
      ? formatThinkingDuration(durationMs)
      : 'Reasoning';

  return (
    <div className="mb-3 rounded-xl border border-amber-200/60 dark:border-amber-700/40 bg-amber-50/40 dark:bg-amber-950/30 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 pr-16 text-left hover:bg-amber-50/60 dark:hover:bg-amber-950/40 transition-colors"
      >
        <svg
          className="w-4 h-4 text-amber-500 flex-shrink-0"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z"
          />
        </svg>
        <span className="text-xs font-medium text-amber-700 dark:text-amber-300">
          {label}
        </span>
        <span className="flex-1" />
        {expanded ? (
          <ChevronUp className="w-3.5 h-3.5 text-amber-400" />
        ) : (
          <ChevronDown className="w-3.5 h-3.5 text-amber-400" />
        )}
      </button>
      {expanded && (
        <div className="px-3 pb-3 text-sm text-amber-900/70 dark:text-amber-300/70 whitespace-pre-wrap break-words max-h-64 overflow-y-auto border-t border-amber-100 dark:border-amber-800/40">
          {content}
        </div>
      )}
    </div>
  );
}

/** 系统提示条：后端 role=system 消息（失败说明/执行底账等） */
function SystemBar({ content, time, showTime }: { content: string; time: string; showTime: boolean }) {
  return (
    <div className="mb-4">
      {showTime && (
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs text-muted-foreground">{time}</span>
          <span className="text-xs font-medium text-muted-foreground">系统</span>
        </div>
      )}
      <div className="mx-auto max-w-fit rounded-full border border-border bg-muted/60 px-4 py-1.5 text-center text-xs text-muted-foreground">
        {content}
      </div>
    </div>
  );
}

export const MessageBubble = memo(
  function MessageBubble({
    message,
    showTime,
    thinkingContent,
    thinkingDurationMs,
  }: MessageBubbleProps) {
    const [copied, setCopied] = useState(false);
    const currentUser = useAuthStore((s) => s.user);
    const agentName = usePersonaStore((s) => s.name);
    const { mode: displayMode } = useDisplayMode();

    // 以 role 为准：is_from_me 在不同来源（历史/乐观更新）语义不一致，不可靠
    const isAI = message.role === 'assistant';
    const content = message.content;
    const time = parseDbTime(message.timestamp)
      .toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      })
      .replace(/\//g, '-');

    const handleCopy = async () => {
      try {
        await navigator.clipboard.writeText(content);
      } catch {
        const textarea = document.createElement('textarea');
        textarea.value = content;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    };

    if (message.role === 'system') {
      return <SystemBar content={content} time={time} showTime={showTime} />;
    }

    // ── Compact mode: all messages left-aligned, no bubbles, full-width ──
    if (displayMode === 'compact') {
      const senderName = isAI ? agentName : currentUser?.displayName || currentUser?.username || '我';

      return (
        <div className="group mb-2 border-b border-border pb-2">
          {/* Sender line — no avatars in compact mode */}
          <div className="flex items-center gap-1.5 mb-1">
            <span
              className={`text-xs font-semibold ${isAI ? 'text-primary' : 'text-muted-foreground'}`}
            >
              {senderName}
            </span>
            {showTime && (
              <span className="text-[11px] text-muted-foreground">{time}</span>
            )}
            <button
              onClick={handleCopy}
              className="ml-1 w-5 h-5 rounded flex items-center justify-center text-muted-foreground/50 hover:text-foreground/70 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
              title="复制"
            >
              {copied ? (
                <Check className="w-3 h-3 text-primary" />
              ) : (
                <Copy className="w-3 h-3" />
              )}
            </button>
          </div>

          {/* Reasoning */}
          {thinkingContent && (
            <ReasoningBlock
              content={thinkingContent}
              durationMs={thinkingDurationMs}
            />
          )}

          {/* Content — strip first-child top margin for consistent spacing */}
          <div className="min-w-0 overflow-hidden [&>div>*:first-child]:!mt-0">
            {isAI ? (
              <MarkdownRenderer content={content} variant="chat" />
            ) : (
              <p className="text-[15px] leading-relaxed whitespace-pre-wrap break-words text-foreground">
                {content}
              </p>
            )}
          </div>
        </div>
      );
    }

    // ── Chat mode (default): bubble-style layout ──
    if (!isAI) {
      // User message: right-aligned
      return (
        <div className="group flex justify-end mb-4">
          <div className="flex flex-col items-end min-w-0 max-w-[75%]">
            <div className="bg-muted text-foreground px-4 py-2.5 rounded-2xl rounded-tr-sm">
              <p className="text-[15px] leading-relaxed whitespace-pre-wrap break-words">
                {content}
              </p>
            </div>
            {showTime && (
              <span className="text-xs text-muted-foreground mt-1.5 mr-1">
                {time}
              </span>
            )}
          </div>
        </div>
      );
    }

    // Assistant message: avatar + name + markdown, Claude-style
    const senderName = agentName;

    return (
      <div className="group mb-4">
        {/* Mobile: compact avatar + name row */}
        <div className="flex items-center gap-2 mb-1.5 lg:hidden">
          <div className="size-7 rounded-full bg-primary/15 flex items-center justify-center text-sm flex-shrink-0">
            🐷
          </div>
          <span className="text-xs text-muted-foreground font-medium">
            {senderName}
          </span>
          {showTime && (
            <span className="text-xs text-muted-foreground">{time}</span>
          )}
        </div>

        {/* Desktop: horizontal avatar + content layout */}
        <div className="lg:flex lg:gap-3">
          <div className="hidden lg:block flex-shrink-0">
            <div className="size-8 rounded-full bg-primary/15 flex items-center justify-center text-sm">
              🐷
            </div>
          </div>
          <div className="flex-1 min-w-0">
            {/* Desktop: name + time row */}
            <div className="hidden lg:flex items-center gap-2 mb-1">
              <span className="text-xs text-muted-foreground font-medium">
                {senderName}
              </span>
              {showTime && (
                <span className="text-xs text-muted-foreground">{time}</span>
              )}
            </div>

            {/* Claude-style: no card container, direct content */}
            <div className="overflow-hidden font-serif">
              {/* Reasoning block — muted left border style */}
              {thinkingContent && (
                <ReasoningBlock
                  content={thinkingContent}
                  durationMs={thinkingDurationMs}
                />
              )}

              {/* Content */}
              <div className="max-w-none overflow-hidden">
                <MarkdownRenderer content={content} variant="chat" />
              </div>
            </div>

            {/* Action toolbar — below content, Claude-style */}
            <div className="flex items-center gap-0.5 mt-1 lg:opacity-0 lg:group-hover:opacity-100 transition-opacity">
              <button
                onClick={handleCopy}
                className="h-7 px-2 rounded-md flex items-center gap-1 text-muted-foreground hover:text-foreground hover:bg-foreground/5 text-xs cursor-pointer transition-colors"
                title="复制"
                aria-label="复制消息"
              >
                {copied ? (
                  <Check className="w-3.5 h-3.5 text-primary" />
                ) : (
                  <Copy className="w-3.5 h-3.5" />
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  },
  (prev, next) =>
    prev.message.id === next.message.id &&
    prev.message.content === next.message.content &&
    prev.showTime === next.showTime &&
    prev.thinkingContent === next.thinkingContent &&
    prev.thinkingDurationMs === next.thinkingDurationMs,
);
