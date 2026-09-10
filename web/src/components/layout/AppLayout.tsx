import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { UnifiedSidebar } from './UnifiedSidebar';
import { BottomTabBar } from './BottomTabBar';
import { ConnectionBanner } from '../common/ConnectionBanner';
import { useTheme } from '../../hooks/useTheme';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { ErrorBoundary } from '../common/ErrorBoundary';

export function AppLayout() {
  const location = useLocation();
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const isChatRoute = location.pathname.startsWith('/chat');
  const hideMobileTabBar = false;
  useTheme(); // 应用并同步持久化的主题偏好

  // Sidebar: expanded only on chat route, collapsed on other routes
  const [userCollapsed, setUserCollapsed] = useState(false);
  const sidebarCollapsed = isChatRoute ? userCollapsed : true;

  // Keyboard shortcut: Cmd+B (Mac) / Ctrl+B (Windows) to toggle sidebar
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
        e.preventDefault();
        if (isChatRoute) setUserCollapsed((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handler);
    return () => {
      window.removeEventListener('keydown', handler);
    };
  }, [isChatRoute]);

  // 更新 document.title
  useEffect(() => {
    document.title = '智牧工作台';
  }, []);

  return (
    <div className="h-screen supports-[height:100dvh]:h-dvh flex flex-col lg:flex-row overflow-hidden safe-area-top">
      {/* `hidden lg:block` 只是视觉隐藏，移动端此前仍会挂载整棵侧边栏并触发数据加载；
          条件挂载让手机只渲染真正可见的那份列表。 */}
      {isDesktop && (
        <div className="hidden lg:block h-full flex-shrink-0">
          <UnifiedSidebar
            collapsed={sidebarCollapsed}
            onToggleCollapse={() => setUserCollapsed((prev) => !prev)}
          />
        </div>
      )}

      <div className="flex-1 min-h-0 flex flex-col overflow-hidden relative">
        <ConnectionBanner />
        <main
          data-app-scroll-root="true"
          className={`flex-1 min-h-0 lg:overflow-auto lg:pb-0 ${
            isChatRoute
              ? 'overflow-hidden'
              : `overflow-y-auto overflow-x-hidden overscroll-y-none ${hideMobileTabBar ? 'pb-6' : 'pb-nav-safe'}`
          }`}
        >
          <ErrorBoundary resetKeys={[location.pathname]}>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>

      {!hideMobileTabBar && <BottomTabBar />}
    </div>
  );
}
