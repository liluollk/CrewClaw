import { useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Menu } from 'lucide-react';

import { useAuthStore } from '../stores/auth';
import { SettingsNav, type SettingsTab } from '../components/settings/SettingsNav';
import { PreferencesSection } from '../components/settings/PreferencesSection';
import { MainAgentIdentitySection } from '../components/settings/MainAgentIdentitySection';
import { ModelSection } from '../components/settings/ModelSection';
import { BindingsSection } from '../components/settings/BindingsSection';
import { MembersSection } from '../components/settings/MembersSection';
import { AboutSection } from '../components/settings/AboutSection';

const VALID_TABS: SettingsTab[] = [
  'preferences',
  'model',
  'identity',
  'channels',
  'members',
  'about',
];

const SECTION_TITLE: Record<SettingsTab, string> = {
  preferences: '偏好设置',
  model: '模型接入',
  identity: '智能体身份',
  channels: 'IM 渠道',
  members: '成员管理',
  about: '关于',
};

/** 设置页（偏好/身份/渠道/成员/关于 五个区块） */
export function SettingsPage() {
  const canManage = useAuthStore((s) => s.canManage());
  const [searchParams, setSearchParams] = useSearchParams();
  const [navOpen, setNavOpen] = useState(false);

  const defaultTab: SettingsTab = 'preferences';
  const rawTab = searchParams.get('tab') as SettingsTab | null;

  const activeTab = useMemo((): SettingsTab => {
    if (rawTab && VALID_TABS.includes(rawTab)) {
      if ((rawTab === 'channels' || rawTab === 'members' || rawTab === 'model') && !canManage) {
        return defaultTab;
      }
      return rawTab;
    }
    return defaultTab;
  }, [rawTab, canManage]);

  const handleTabChange = useCallback(
    (tab: SettingsTab) => {
      setNavOpen(false);
      setSearchParams({ tab }, { replace: true });
    },
    [setSearchParams],
  );

  return (
    <div
      data-settings-page="true"
      className="min-h-full bg-background lg:flex lg:items-start"
    >
      {/* Mobile header */}
      <div className="lg:hidden sticky top-0 z-10 flex items-center bg-background border-b border-border px-4 h-12">
        <button
          onClick={() => setNavOpen(true)}
          className="-ml-2 flex size-11 items-center justify-center rounded-lg transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          aria-label="打开导航"
        >
          <Menu className="w-5 h-5 text-muted-foreground" />
        </button>
        <span className="ml-3 text-sm font-semibold text-foreground truncate">
          {SECTION_TITLE[activeTab]}
        </span>
      </div>

      <SettingsNav
        activeTab={activeTab}
        onTabChange={handleTabChange}
        canManage={canManage}
        open={navOpen}
        onOpenChange={setNavOpen}
      />

      <div data-settings-content="true" className="min-w-0 flex-1">
        <div className="px-4 py-6 sm:px-6 lg:px-10 lg:py-8">
          <div className="mx-auto max-w-6xl">
            <header className="mb-6">
              <h1 className="text-2xl font-bold text-foreground">
                {SECTION_TITLE[activeTab]}
              </h1>
            </header>

            {activeTab === 'preferences' && <PreferencesSection />}
            {activeTab === 'model' && <ModelSection />}
            {activeTab === 'identity' && <MainAgentIdentitySection />}
            {activeTab === 'channels' && <BindingsSection />}
            {activeTab === 'members' && <MembersSection />}
            {activeTab === 'about' && <AboutSection />}
          </div>
        </div>
      </div>
    </div>
  );
}
