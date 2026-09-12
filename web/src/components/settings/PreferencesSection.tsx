import {
  Monitor,
  Moon,
  Palette,
  Sun,
} from 'lucide-react';

import { Label } from '@/components/ui/label';
import {
  useTheme,
  type ColorScheme,
  type FontStyle,
  type Theme,
} from '../../hooks/useTheme';
import { SettingsCard as Section } from './SettingsCard';

const THEME_OPTIONS: { value: Theme; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: '浅色', icon: Sun },
  { value: 'dark', label: '深色', icon: Moon },
  { value: 'system', label: '跟随系统', icon: Monitor },
];

const SCHEME_OPTIONS: {
  value: ColorScheme;
  label: string;
  preview: { bg: string; accent: string; text: string };
}[] = [
  {
    value: 'default',
    label: '经典绿',
    preview: { bg: '#f8fafc', accent: '#0d9488', text: '#0f172a' },
  },
  {
    value: 'orange',
    label: '暖橙',
    preview: { bg: '#faf9f5', accent: '#f97316', text: '#141413' },
  },
  {
    value: 'neutral',
    label: '素白',
    preview: { bg: '#fafafa', accent: '#52525b', text: '#18181b' },
  },
];

const FONT_OPTIONS: {
  value: FontStyle;
  label: string;
  sample: string;
  fontFamily: string;
}[] = [
  {
    value: 'default',
    label: '默认',
    sample: 'Hello 你好',
    fontFamily: "'Inter Variable', system-ui, sans-serif",
  },
  {
    value: 'anthropic',
    label: 'Anthropic',
    sample: 'Hello 你好',
    fontFamily: "Georgia, 'Noto Serif SC', serif",
  },
];

function OptionButton({
  active,
  onClick,
  children,
  className = '',
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`min-h-11 rounded-xl border-2 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
        active
          ? 'border-primary bg-primary/5'
          : 'border-border hover:border-muted-foreground/40'
      } ${className}`}
    >
      {children}
    </button>
  );
}

/** 偏好设置（纯客户端外观偏好，存当前设备 localStorage） */
export function PreferencesSection() {
  const {
    theme,
    setTheme,
    colorScheme,
    setColorScheme,
    fontStyle,
    setFontStyle,
  } = useTheme();

  return (
    <Section
      icon={Palette}
      title="界面外观"
      desc="当前设备：主题、配色和字体不会同步到其他浏览器"
    >
      <div>
        <Label className="mb-2 text-xs text-muted-foreground">配色方案</Label>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {SCHEME_OPTIONS.map((option) => (
            <OptionButton
              key={option.value}
              active={colorScheme === option.value}
              onClick={() => setColorScheme(option.value)}
              className="flex flex-col gap-2 p-2.5"
            >
              <div
                className="flex h-10 w-full items-end gap-1 rounded-lg border border-border/60 p-1.5"
                style={{ background: option.preview.bg }}
              >
                <div
                  className="size-4 rounded-full"
                  style={{ background: option.preview.accent }}
                />
                <div className="flex-1 space-y-0.5">
                  <div
                    className="h-1 w-3/4 rounded-full opacity-60"
                    style={{ background: option.preview.text }}
                  />
                  <div
                    className="h-1 w-1/2 rounded-full opacity-25"
                    style={{ background: option.preview.text }}
                  />
                </div>
              </div>
              <span className="text-xs font-medium text-foreground">
                {option.label}
              </span>
            </OptionButton>
          ))}
        </div>
      </div>

      <div>
        <Label className="mb-2 text-xs text-muted-foreground">明暗模式</Label>
        <div className="grid grid-cols-3 gap-2">
          {THEME_OPTIONS.map((option) => {
            const Icon = option.icon;
            return (
              <OptionButton
                key={option.value}
                active={theme === option.value}
                onClick={() => setTheme(option.value)}
                className="flex flex-col items-center gap-1 px-2 py-2.5"
              >
                <Icon className="size-4 text-muted-foreground" />
                <span className="text-xs font-medium text-foreground">
                  {option.label}
                </span>
              </OptionButton>
            );
          })}
        </div>
      </div>

      <div>
        <Label className="mb-2 text-xs text-muted-foreground">字体风格</Label>
        <div className="grid grid-cols-2 gap-2">
          {FONT_OPTIONS.map((option) => (
            <OptionButton
              key={option.value}
              active={fontStyle === option.value}
              onClick={() => setFontStyle(option.value)}
              className="flex flex-col gap-1.5 p-2.5"
            >
              <span
                className="truncate text-sm leading-snug text-foreground"
                style={{ fontFamily: option.fontFamily }}
              >
                {option.sample}
              </span>
              <span className="text-xs font-medium text-foreground">
                {option.label}
              </span>
            </OptionButton>
          ))}
        </div>
      </div>
    </Section>
  );
}
