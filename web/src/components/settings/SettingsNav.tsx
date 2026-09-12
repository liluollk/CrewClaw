import { Palette, Bot, Cable, Users, Info, SlidersHorizontal, Cpu } from 'lucide-react';

export type SettingsTab =
  | 'preferences'
  | 'model'
  | 'identity'
  | 'channels'
  | 'members'
  | 'about';

interface NavItem {
  key: SettingsTab;
  label: string;
  icon: React.ReactNode;
  canManageOnly?: boolean;
}

const ALL_ITEMS: NavItem[] = [
  { key: 'preferences', label: '偏好设置', icon: <SlidersHorizontal className="size-4" /> },
  { key: 'model', label: '模型接入', icon: <Cpu className="size-4" />, canManageOnly: true },
  { key: 'identity', label: '智能体身份', icon: <Bot className="size-4" /> },
  { key: 'channels', label: 'IM 渠道', icon: <Cable className="size-4" />, canManageOnly: true },
  { key: 'members', label: '成员管理', icon: <Users className="size-4" />, canManageOnly: true },
  { key: 'about', label: '关于智牧工作台', icon: <Info className="size-4" /> },
];

interface SettingsNavProps {
  activeTab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
  canManage: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const SECTIONS: Array<{ label: string; pick: (item: NavItem) => boolean }> = [
  { label: '常规', pick: (item) => item.key === 'preferences' },
  { label: '智能体', pick: (item) => item.key === 'model' || item.key === 'identity' },
  { label: '工作区', pick: (item) => item.key === 'channels' || item.key === 'members' },
  { label: '其他', pick: (item) => item.key === 'about' },
];

/** 设置页左侧导航（4 组 5 项） */
export function SettingsNav({
  activeTab,
  onTabChange,
  canManage,
  open,
  onOpenChange,
}: SettingsNavProps) {
  const visibleItems = ALL_ITEMS.filter(
    (item) => !item.canManageOnly || canManage,
  );

  const nav = (
    <nav className="flex flex-col gap-6 px-2 py-4">
      {SECTIONS.map((section, index) => {
        const items = visibleItems.filter(section.pick);
        if (items.length === 0) return null;
        return (
          <div key={section.label} className={index > 0 ? 'mt-1' : ''}>
            <p className="px-3 pb-2 text-[10px] font-medium tracking-[0.08em] text-muted-foreground">
              {section.label}
            </p>
            <div className="flex flex-col gap-0.5">
              {items.map((item) => {
                const isActive = activeTab === item.key;
                return (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => {
                      onTabChange(item.key);
                      onOpenChange(false);
                    }}
                    className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors cursor-pointer ${
                      isActive
                        ? 'bg-brand-50 font-medium text-primary dark:bg-brand-950/40'
                        : 'text-foreground/80 hover:bg-accent'
                    }`}
                  >
                    {item.icon}
                    {item.label}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
      <div className="mt-2 flex items-center gap-2 px-3 text-xs text-muted-foreground">
        <Palette className="size-3.5" />
        智牧工作台
      </div>
    </nav>
  );

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="hidden w-56 shrink-0 border-r border-border lg:block">
        <div className="sticky top-0 py-4">{nav}</div>
      </aside>

      {/* Mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => onOpenChange(false)}
            aria-hidden="true"
          />
          <div className="absolute inset-y-0 left-0 w-64 overflow-y-auto bg-background shadow-xl">
            {nav}
          </div>
        </div>
      )}
    </>
  );
}
