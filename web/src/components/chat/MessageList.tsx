import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useMemo,
  useCallback,
} from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Message, useChatStore } from '../../stores/chat';
import { MessageBubble } from './MessageBubble';
import { StreamingDisplay } from './StreamingDisplay';
import { ErrorBoundary } from '../common';
import {
  Loader2,
  ChevronUp,
  ChevronDown,
  BarChart3,
  ClipboardPen,
  BookOpen,
  ListChecks,
} from 'lucide-react';
import { useDisplayMode } from '../../hooks/useDisplayMode';
import { parseDbTime } from '../../utils/db-time';
import { usePersonaStore } from '../../stores/persona';

interface MessageListProps {
  messages: Message[];
  loading: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
  /** Increment to force scroll to bottom (e.g. after sending a message) */
  scrollTrigger?: number;
  /** Whether the agent is currently processing */
  isWaiting?: boolean;
  /** Callback to send a message (used for quick prompts in empty state) */
  onSend?: (content: string) => void;
}

type FlatItem =
  | { type: 'date'; content: string }
  | { type: 'message'; content: Message };

// Intl.DateTimeFormat construction is expensive; reuse one instance across all
// rows so flatMessages doesn't re-pay the cost per message on every re-group.
const DATE_LABEL_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
});

const quickPrompts = [
  { icon: BarChart3, title: '查猪舍指标', desc: '查一下 A3 猪舍近期的生产指标，判断风险' },
  { icon: ClipboardPen, title: '记录异常观察', desc: '记录一条 A3 猪舍的异常观察：咳嗽，多头出现' },
  { icon: BookOpen, title: '查养殖规范', desc: '查一下生物安全消毒流程的规范要求' },
  { icon: ListChecks, title: '建复检任务', desc: '为 A3 猪舍创建一个复检任务，原因是采食量下降' },
];

export function MessageList({
  messages,
  loading,
  hasMore,
  onLoadMore,
  scrollTrigger,
  isWaiting,
  onSend,
}: MessageListProps) {
  const { mode: displayMode } = useDisplayMode();
  const agentName = usePersonaStore((s) => s.name);
  const parentRef = useRef<HTMLDivElement>(null);
  const scrollStateRef = useRef({ autoScroll: true, atTop: false });
  const [autoScroll, setAutoScroll] = useState(true);
  const [atTop, setAtTop] = useState(false);
  const prevMessageCount = useRef(messages.length);
  // Window during which the scroll handler ignores updates and the streaming
  // RAF skips its catch-up scroll, so a user-initiated smooth scroll can run
  // uninterrupted (≈500ms browser default + 100ms slack).
  const smoothScrollUntilRef = useRef(0);
  const smoothCatchUpTimerRef = useRef<number | null>(null);
  const SMOOTH_SCROLL_LOCK_MS = 600;

  const scheduleSmoothCatchUp = useCallback(() => {
    if (smoothCatchUpTimerRef.current !== null) {
      window.clearTimeout(smoothCatchUpTimerRef.current);
    }
    const delay = Math.max(0, smoothScrollUntilRef.current - Date.now()) + 16;
    smoothCatchUpTimerRef.current = window.setTimeout(() => {
      smoothCatchUpTimerRef.current = null;
      if (!scrollStateRef.current.autoScroll) return;
      const parent = parentRef.current;
      if (!parent) return;
      parent.scrollTo({ top: parent.scrollHeight });
    }, delay);
  }, []);

  useEffect(() => {
    return () => {
      if (smoothCatchUpTimerRef.current !== null) {
        window.clearTimeout(smoothCatchUpTimerRef.current);
      }
    };
  }, []);

  // Compute flatMessages (with date headers) before virtualizer
  const flatMessages = useMemo<FlatItem[]>(() => {
    const grouped = messages.reduce(
      (acc, msg) => {
        const date = DATE_LABEL_FORMATTER.format(parseDbTime(msg.timestamp));
        if (!acc[date]) acc[date] = [];
        acc[date].push(msg);
        return acc;
      },
      {} as Record<string, Message[]>,
    );

    const items: FlatItem[] = [];
    Object.entries(grouped).forEach(([date, msgs]) => {
      items.push({ type: 'date', content: date });
      msgs.forEach((msg) => {
        items.push({ type: 'message', content: msg });
      });
    });
    return items;
  }, [messages]);

  // Chat always starts at bottom — no scroll position restoration.
  const virtualizer = useVirtualizer({
    count: flatMessages.length,
    getScrollElement: () => parentRef.current,
    initialOffset: flatMessages.length > 0 ? 99999999 : 0,
    getItemKey: (index) => {
      const item = flatMessages[index];
      if (!item) return index;
      switch (item.type) {
        case 'date':
          return `date-${item.content}`;
        case 'message':
          return item.content.id;
      }
    },
    estimateSize: (index) => {
      const item = flatMessages[index];
      if (!item) return 100;
      switch (item.type) {
        case 'date':
          return 48;
        case 'message': {
          const len = item.content.content.length;
          if (item.content.is_from_me) {
            // AI messages often contain markdown tables, code blocks, and
            // structured content that renders much taller than plain text.
            // A low cap causes the virtualizer to miscalculate total height,
            // leading to scroll position oscillation (visible flickering).
            return Math.max(80, Math.ceil(len / 40) * 24 + 80);
          }
          return Math.max(48, Math.min(200, Math.ceil(len / 80) * 24 + 40));
        }
        default:
          return 100;
      }
    },
    overscan: window.innerWidth < 1024 ? 12 : 8,
  });

  // Detect at-bottom (autoScroll) and at-top (loadMore) via the scroll event.
  // Critically, this fires only on actual scroll events — not when scrollHeight
  // grows during streaming with scrollTop unchanged. The ref is updated
  // synchronously to avoid races with the streaming RAF catch-up.
  useEffect(() => {
    const parent = parentRef.current;
    if (!parent) return;

    const handleScroll = () => {
      // While a programmatic smooth scroll is animating, ignore intermediate
      // scroll events — they would briefly set autoScroll=false mid-animation
      // and flicker the floating "scroll to bottom" button.
      if (Date.now() < smoothScrollUntilRef.current) return;

      const { scrollTop, scrollHeight, clientHeight } = parent;
      const isAtBottom = scrollHeight - scrollTop - clientHeight < 10;
      const isAtTop = scrollTop < 50;

      if (scrollStateRef.current.autoScroll !== isAtBottom) {
        scrollStateRef.current.autoScroll = isAtBottom;
        setAutoScroll(isAtBottom);
      }
      if (scrollStateRef.current.atTop !== isAtTop) {
        scrollStateRef.current.atTop = isAtTop;
        setAtTop(isAtTop);
      }

      if (scrollTop < 100 && hasMore && !loading) {
        onLoadMore();
      }
    };

    parent.addEventListener('scroll', handleScroll);
    return () => parent.removeEventListener('scroll', handleScroll);
  }, [hasMore, loading, onLoadMore]);

  // 新消息自动滚到底部
  useEffect(() => {
    if (autoScroll && messages.length > prevMessageCount.current) {
      requestAnimationFrame(() => {
        const parent = parentRef.current;
        if (!parent) return;
        smoothScrollUntilRef.current = Date.now() + SMOOTH_SCROLL_LOCK_MS;
        parent.scrollTo({ top: parent.scrollHeight, behavior: 'smooth' });
        scheduleSmoothCatchUp();
      });
    }
    prevMessageCount.current = messages.length;
  }, [messages.length, autoScroll, scheduleSmoothCatchUp]);

  // 外部触发滚到底部（发送消息后）
  useEffect(() => {
    if (scrollTrigger && scrollTrigger > 0) {
      scrollStateRef.current.autoScroll = true;
      setAutoScroll(true);
      requestAnimationFrame(() => {
        const parent = parentRef.current;
        if (!parent) return;
        smoothScrollUntilRef.current = Date.now() + SMOOTH_SCROLL_LOCK_MS;
        parent.scrollTo({ top: parent.scrollHeight, behavior: 'smooth' });
        scheduleSmoothCatchUp();
      });
    }
  }, [scrollTrigger, scheduleSmoothCatchUp]);

  // Fallback: 消息在挂载后加载（首次页面加载时 store 为空）
  // initialOffset 只在挂载时生效，消息后加载需要手动定位
  const initialScrollDone = useRef(flatMessages.length > 0);
  useLayoutEffect(() => {
    if (!initialScrollDone.current && flatMessages.length > 0) {
      initialScrollDone.current = true;
      prevMessageCount.current = messages.length;
      virtualizer.scrollToIndex(flatMessages.length - 1, { align: 'end' });
      if (parentRef.current) {
        parentRef.current.scrollTop = parentRef.current.scrollHeight;
      }
      setAutoScroll(true);
      // 4-frame rAF chain (~66ms) to wait for measureElement to complete
      let handle: number;
      const correct = (depth: number) => {
        handle = requestAnimationFrame(() => {
          if (parentRef.current) {
            parentRef.current.scrollTop = parentRef.current.scrollHeight;
          }
          if (depth < 3) correct(depth + 1);
        });
      };
      correct(0);
      return () => cancelAnimationFrame(handle);
    }
  }, [flatMessages.length, virtualizer, messages.length]);

  // Auto-scroll when streaming content is active. Subscribes directly to the
  // chat store (no React re-render) and schedules a single rAF-coalesced
  // scrollTo per animation frame, regardless of how many delta updates land.
  const hasStreaming = useChatStore((s) => s.streaming.active);
  useEffect(() => {
    if (!hasStreaming) return;

    let raf = 0;
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        // Yield to any in-progress smooth scroll so we don't snap-interrupt it.
        if (Date.now() < smoothScrollUntilRef.current) {
          scheduleSmoothCatchUp();
          return;
        }
        if (!scrollStateRef.current.autoScroll) return;
        const parent = parentRef.current;
        if (!parent) return;
        parent.scrollTo({ top: parent.scrollHeight });
      });
    };

    let prevText = useChatStore.getState().streaming.partialText;
    let prevThinking = useChatStore.getState().streaming.thinkingText;

    const unsubscribe = useChatStore.subscribe((state) => {
      const curText = state.streaming.partialText;
      const curThinking = state.streaming.thinkingText;
      if (curText !== prevText || curThinking !== prevThinking) {
        prevText = curText;
        prevThinking = curThinking;
        schedule();
      }
    });

    return () => {
      unsubscribe();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [hasStreaming, scheduleSmoothCatchUp]);

  const scrollToTop = useCallback(() => {
    parentRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const scrollToBottom = useCallback(() => {
    scrollStateRef.current.autoScroll = true;
    setAutoScroll(true);
    smoothScrollUntilRef.current = Date.now() + SMOOTH_SCROLL_LOCK_MS;
    const parent = parentRef.current;
    if (!parent) return;
    parent.scrollTo({ top: parent.scrollHeight, behavior: 'smooth' });
    scheduleSmoothCatchUp();
  }, [scheduleSmoothCatchUp]);

  const showScrollButtons = messages.length > 0;

  return (
    <div className="relative flex-1 overflow-hidden overflow-x-hidden">
      <div
        ref={parentRef}
        className="h-full overflow-y-auto overflow-x-hidden pb-10 pt-6"
      >
        <div
          className={
            displayMode === 'compact'
              ? 'mx-auto w-full max-w-[64rem] px-4 min-w-0'
              : 'mx-auto w-full max-w-[64rem] px-4 min-w-0'
          }
        >
          {loading && hasMore && (
            <div className="flex justify-center py-4">
              <Loader2 className="animate-spin text-primary" size={24} />
            </div>
          )}

          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: '100%',
              position: 'relative',
            }}
          >
            {virtualizer.getVirtualItems().map((virtualItem) => {
              const item = flatMessages[virtualItem.index];
              if (!item) return null;

              if (item.type === 'date') {
                return (
                  <div
                    key={virtualItem.key}
                    ref={virtualizer.measureElement}
                    data-index={virtualItem.index}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${virtualItem.start}px)`,
                    }}
                  >
                    <div className="flex justify-center my-6">
                      <span className="bg-surface px-4 py-1 rounded-full text-xs text-muted-foreground border border-border">
                        {item.content}
                      </span>
                    </div>
                  </div>
                );
              }

              const message = item.content;
              const showTime = true;

              return (
                <div
                  key={virtualItem.key}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualItem.start}px)`,
                  }}
                  ref={virtualizer.measureElement}
                  data-index={virtualItem.index}
                >
                  <ErrorBoundary>
                    <MessageBubble message={message} showTime={showTime} />
                  </ErrorBoundary>
                </div>
              );
            })}
          </div>

          {messages.length === 0 && !loading && (
            <div
              data-hc-empty-state
              className="absolute inset-x-0 top-0 bottom-0 flex justify-center px-6 pt-[clamp(4.5rem,14vh,9rem)]"
            >
              <div className="w-full max-w-3xl">
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 shrink-0 size-10 rounded-full bg-primary/15 flex items-center justify-center text-lg">
                    🐷
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-xl font-semibold leading-7 text-foreground">
                      我是{agentName}，今天猪场有什么要跟进的？
                    </p>
                  </div>
                </div>

                {onSend && (
                  <div className="mt-6 grid gap-2.5 sm:grid-cols-2">
                    {quickPrompts.map((prompt) => (
                      <button
                        key={prompt.title}
                        onClick={() => onSend(prompt.desc)}
                        className="group min-h-[72px] rounded-lg border border-border/70 bg-background/70 px-3.5 py-3 text-left transition-colors hover:border-border hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.99] cursor-pointer"
                      >
                        <div className="flex items-start gap-3">
                          <prompt.icon
                            className="mt-0.5 h-4.5 w-4.5 shrink-0 text-muted-foreground group-hover:text-foreground"
                            strokeWidth={1.75}
                          />
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-medium text-foreground">
                              {prompt.title}
                            </span>
                            <span className="mt-0.5 block overflow-hidden text-ellipsis text-xs leading-5 text-muted-foreground">
                              {prompt.desc}
                            </span>
                          </span>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          <StreamingDisplay isWaiting={!!isWaiting} senderName={agentName} />
        </div>
      </div>

      {/* Floating scroll buttons */}
      {showScrollButtons && (
        <div className="absolute right-4 bottom-4 flex flex-col gap-1.5">
          {!atTop && (
            <button
              onClick={scrollToTop}
              className="w-8 h-8 rounded-full bg-foreground/5 backdrop-blur-sm flex items-center justify-center text-muted-foreground/60 hover:text-foreground hover:bg-foreground/10 transition-all cursor-pointer"
              title="回到顶部"
            >
              <ChevronUp className="w-4 h-4" />
            </button>
          )}
          {!autoScroll && (
            <button
              onClick={scrollToBottom}
              className="w-8 h-8 rounded-full bg-foreground/5 backdrop-blur-sm flex items-center justify-center text-muted-foreground/60 hover:text-foreground hover:bg-foreground/10 transition-all cursor-pointer"
              title="回到底部"
            >
              <ChevronDown className="w-4 h-4" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
