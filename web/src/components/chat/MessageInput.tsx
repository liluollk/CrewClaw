import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Loader2, Square } from 'lucide-react';
import { useMediaQuery } from '../../hooks/useMediaQuery';

interface MessageInputProps {
  onSend: (content: string) => Promise<boolean | void>;
  disabled?: boolean;
  /** Whether the agent is currently processing — swaps send for stop */
  isRunning?: boolean;
  onStop?: () => void;
  placeholder?: string;
}

/** 聊天输入框（单行横向布局，多行时向上生长；纯文本，去文件上传/队列） */
export function MessageInput({
  onSend,
  disabled = false,
  isRunning = false,
  onStop,
  placeholder = '输入消息...',
}: MessageInputProps) {
  const [content, setContent] = useState('');
  const [sending, setSending] = useState(false);
  const isMobile = !useMediaQuery('(min-width: 1024px)');
  const composingRef = useRef(false);
  const compositionEndTimeRef = useRef(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea (1-5 lines), growing upward from a single row
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = '0px';
    const scrollHeight = textarea.scrollHeight;
    const newHeight = Math.max(24, Math.min(120, scrollHeight));
    textarea.style.height = `${newHeight}px`;
  }, [content]);

  const showStop = isRunning && !!onStop;
  const canSend = content.trim().length > 0;

  const handleSend = async () => {
    const trimmed = content.trim();
    if (!trimmed || disabled || sending) return;
    setSending(true);
    try {
      const ok = await onSend(trimmed);
      if (ok !== false) setContent('');
    } finally {
      setSending(false);
      textareaRef.current?.focus();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (composingRef.current || e.nativeEvent.isComposing) return;
    if (e.key === 'Enter' && !e.shiftKey && !isMobile) {
      if (Date.now() - compositionEndTimeRef.current < 100) return;
      e.preventDefault();
      if (showStop) return;
      void handleSend();
    }
  };

  return (
    <div className="mx-auto w-full max-w-[64rem] px-4 pb-3 pt-1">
      <div className="flex items-center gap-2 rounded-2xl border border-border bg-surface py-2 pl-4 pr-2 shadow-card focus-within:border-border/80">
        <textarea
          ref={textareaRef}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={handleKeyDown}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
            compositionEndTimeRef.current = Date.now();
          }}
          placeholder={placeholder}
          disabled={disabled}
          className="min-h-[24px] max-h-[120px] flex-1 self-center resize-none bg-transparent text-base leading-6 focus:outline-none placeholder:text-muted-foreground disabled:opacity-50 disabled:cursor-not-allowed"
          rows={1}
        />

        <button
          type="button"
          onClick={() => (showStop ? onStop() : void handleSend())}
          disabled={showStop ? disabled : !canSend || disabled || sending}
          title={showStop ? '停止当前运行' : '发送消息'}
          aria-label={showStop ? '停止当前运行' : '发送消息'}
          className={`h-9 w-9 shrink-0 rounded-full flex items-center justify-center transition-all cursor-pointer active:scale-90 ${
            showStop && !disabled
              ? 'bg-foreground text-background hover:bg-foreground/90'
              : canSend && !disabled && !sending
                ? 'bg-primary text-white hover:bg-primary/90 max-lg:shadow-[0_2px_8px_rgba(249,115,22,0.3)]'
                : 'bg-muted text-muted-foreground'
          } focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2`}
        >
          {sending ? (
            <Loader2 className="w-4.5 h-4.5 animate-spin" />
          ) : showStop ? (
            <Square className="w-4 h-4 fill-current" />
          ) : (
            <ArrowUp className="w-4.5 h-4.5" />
          )}
        </button>
      </div>
    </div>
  );
}
