import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Loader2 } from 'lucide-react';
import { useChatStore } from '../../stores/chat';
import { MarkdownRenderer } from './MarkdownRenderer';
import { ToolActivityCard } from './ToolActivityCard';
import { useDisplayMode } from '../../hooks/useDisplayMode';

interface StreamingDisplayProps {
  isWaiting: boolean;
  senderName?: string;
}

/** 流式回合的实时展示：思考块 + 工具活动卡 + 部分文本（） */
export function StreamingDisplay({ isWaiting, senderName = '助手' }: StreamingDisplayProps) {
  const streaming = useChatStore((s) => s.streaming);
  const { mode: displayMode } = useDisplayMode();
  const isCompact = displayMode === 'compact';
  const [thinkingExpanded, setThinkingExpanded] = useState(true);
  const thinkingRef = useRef<HTMLDivElement>(null);
  const userScrolledRef = useRef(false);
  const [localElapsed, setLocalElapsed] = useState<Record<string, number>>({});

  // Local elapsed timer for tools — tick per active tool membership.
  const activeToolIdSignature =
    streaming.activeTools.map((t) => t.name).join('|') ?? '';
  useEffect(() => {
    if (!activeToolIdSignature) {
      setLocalElapsed({});
      return;
    }
    const interval = setInterval(() => {
      const now = Date.now();
      const tools = useChatStore.getState().streaming.activeTools;
      const next: Record<string, number> = {};
      for (const tool of tools) {
        next[tool.name] = (now - tool.startedAt) / 1000;
      }
      setLocalElapsed(next);
    }, 1000);
    return () => clearInterval(interval);
  }, [activeToolIdSignature]);

  // Auto-scroll thinking content (unless user scrolled up)
  useEffect(() => {
    if (!thinkingExpanded || !thinkingRef.current || userScrolledRef.current)
      return;
    const el = thinkingRef.current;
    el.scrollTop = el.scrollHeight;
  }, [streaming.thinkingText, thinkingExpanded]);

  useEffect(() => {
    if (!streaming.active) {
      setThinkingExpanded(true);
      userScrolledRef.current = false;
    }
  }, [streaming.active]);

  const isThinking = streaming.active && !streaming.partialText && !!streaming.thinkingText;
  const hasStreamData =
    streaming.partialText || streaming.thinkingText || streaming.activeTools.length > 0 || streaming.timeline.length > 0;

  // 仅在既不等待也无流式数据时才隐藏
  if (!isWaiting && !streaming.active && !hasStreamData) return null;

  const streamingContent = (
    <>
      {/* Thinking block */}
      {streaming.thinkingText && (
        <div className="mb-3 rounded-xl border border-amber-200/60 dark:border-amber-700/40 bg-amber-50/40 dark:bg-amber-950/30 overflow-hidden">
          <button
            onClick={() => {
              setThinkingExpanded(!thinkingExpanded);
              if (!thinkingExpanded) userScrolledRef.current = false;
            }}
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
              {isThinking ? 'Reasoning...' : 'Reasoning'}
            </span>
            {isThinking && (
              <span className="flex gap-0.5 ml-0.5">
                <span className="w-1 h-1 bg-amber-400 rounded-full animate-bounce [animation-delay:-0.3s]" />
                <span className="w-1 h-1 bg-amber-400 rounded-full animate-bounce [animation-delay:-0.15s]" />
                <span className="w-1 h-1 bg-amber-400 rounded-full animate-bounce" />
              </span>
            )}
            <span className="flex-1" />
            {thinkingExpanded ? (
              <ChevronUp className="w-3.5 h-3.5 text-amber-400" />
            ) : (
              <ChevronDown className="w-3.5 h-3.5 text-amber-400" />
            )}
          </button>
          {thinkingExpanded && (
            <div
              ref={thinkingRef}
              onScroll={() => {
                if (!thinkingRef.current) return;
                const el = thinkingRef.current;
                userScrolledRef.current =
                  el.scrollHeight - el.scrollTop - el.clientHeight >= 30;
              }}
              className="px-3 pb-3 text-sm text-amber-900/70 dark:text-amber-200/70 whitespace-pre-wrap break-words max-h-64 overflow-y-auto border-t border-amber-100 dark:border-amber-800/50"
            >
              {streaming.thinkingText}
            </div>
          )}
        </div>
      )}

      {/* Active tools */}
      {streaming.activeTools.length > 0 && (
        <div className="mb-2 space-y-1.5">
          {streaming.activeTools.map((tool, i) => (
            <ToolActivityCard
              key={`${tool.name}-${i}`}
              tool={{
                toolName: tool.name,
                toolUseId: `${tool.name}-${i}`,
                startTime: tool.startedAt,
              }}
              localElapsed={localElapsed[tool.name]}
            />
          ))}
        </div>
      )}

      {/* Completed tool timeline（本轮已完成的工具调用，弱化展示） */}
      {streaming.timeline.length > 0 && streaming.activeTools.length === 0 && (
        <div className="mb-2 text-[13px] text-muted-foreground space-y-0.5">
          {streaming.timeline.slice(-5).map((item) => (
            <div key={item.id}>{item.text}</div>
          ))}
        </div>
      )}

      {/* Partial text */}
      {streaming.partialText && (
        <div className="max-w-none overflow-hidden [&>div>*:first-child]:!mt-0">
          <MarkdownRenderer
            content={
              streaming.partialText.length > 3000
                ? '...' + streaming.partialText.slice(-2000)
                : streaming.partialText
            }
            variant="chat"
            streaming
          />
        </div>
      )}
    </>
  );

  // Waiting but no stream data: show an accessible loading indicator
  if (!hasStreamData) {
    if (isCompact) {
      return (
        <div className="mb-2 border-b border-border pb-2">
          <div className="flex items-center gap-1.5 mb-1">
            <span className="text-xs font-semibold text-primary">
              {senderName}
            </span>
          </div>
          <div
            role="status"
            aria-live="polite"
            className="flex items-center gap-2"
          >
            <Loader2
              aria-hidden="true"
              className="h-4 w-4 animate-spin text-primary motion-reduce:animate-none"
            />
            <span className="text-sm text-muted-foreground">正在准备回复…</span>
          </div>
        </div>
      );
    }
    return (
      <div className="max-w-4xl mx-auto w-full px-4 py-3">
        {/* Mobile: compact avatar + name row */}
        <div className="flex items-center gap-2 mb-1.5 lg:hidden">
          <div className="size-7 rounded-full bg-primary/15 flex items-center justify-center text-sm flex-shrink-0">
            🐷
          </div>
          <span className="text-xs text-muted-foreground font-medium">
            {senderName}
          </span>
        </div>

        <div className="lg:flex lg:gap-3">
          <div className="hidden lg:block flex-shrink-0">
            <div className="size-8 rounded-full bg-primary/15 flex items-center justify-center text-sm">
              🐷
            </div>
          </div>
          <div className="flex-1 min-w-0">
            <div className="hidden lg:flex items-center gap-2 mb-1">
              <span className="text-xs text-muted-foreground font-medium">
                {senderName}
              </span>
            </div>
            <div className="bg-surface rounded-xl border border-border/60 px-5 py-4 font-serif shadow-card">
              <div
                role="status"
                aria-live="polite"
                className="flex items-center gap-2"
              >
                <Loader2
                  aria-hidden="true"
                  className="h-4 w-4 animate-spin text-primary motion-reduce:animate-none"
                />
                <span className="text-sm text-muted-foreground">
                  正在准备回复…
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Compact mode streaming ──
  if (isCompact) {
    return (
      <div className="mb-2 border-b border-border pb-2">
        {/* Sender line */}
        <div className="flex items-center gap-1.5 mb-1">
          <span className="text-xs font-semibold text-primary">
            {senderName}
          </span>
        </div>

        {/* Content — flat, no card wrapper */}
        <div className="min-w-0 overflow-hidden">{streamingContent}</div>
      </div>
    );
  }

  // ── Chat mode streaming (default) ──
  return (
    <div className="max-w-4xl mx-auto w-full px-4 py-3">
      {/* Mobile: compact avatar + name row */}
      <div className="flex items-center gap-2 mb-1.5 lg:hidden">
        <div className="size-7 rounded-full bg-primary/15 flex items-center justify-center text-sm flex-shrink-0">
          🐷
        </div>
        <span className="text-xs text-muted-foreground font-medium">
          {senderName}
        </span>
      </div>

      <div className="lg:flex lg:gap-3">
        <div className="hidden lg:block flex-shrink-0">
          <div className="size-8 rounded-full bg-primary/15 flex items-center justify-center text-sm">
            🐷
          </div>
        </div>
        <div className="flex-1 min-w-0">
          {/* Desktop: name row */}
          <div className="hidden lg:flex items-center gap-2 mb-1">
            <span className="text-xs text-muted-foreground font-medium">
              {senderName}
            </span>
          </div>

          <div className="bg-surface rounded-xl border border-border/60 px-5 py-4 overflow-hidden font-serif shadow-card">
            {streamingContent}
          </div>
        </div>
      </div>
    </div>
  );
}
