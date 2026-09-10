import { useEffect, useMemo } from 'react';
import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import { PanelLeftClose, LogOut, UserCog } from 'lucide-react';
import { useAuthStore } from '../../stores/auth';
import { useWorkspaceStore } from '../../stores/workspace';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { SkeletonCardList } from '@/components/common/Skeletons';
import { cn } from '@/lib/utils';
import { navItems } from './nav-items';

interface UnifiedSidebarProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
}

/** 左侧导航栏 + 可展开的工作区列表面板（单会话，无多会话树） */
export function UnifiedSidebar({
  collapsed,
  onToggleCollapse,
}: UnifiedSidebarProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const isChatRoute = location.pathname.startsWith('/chat');
  const showWorkspaceList = isChatRoute && !collapsed;

  const user = useAuthStore((s) => s.user);
  const userInitial = (user?.displayName || user?.username || '?')[0].toUpperCase();

  const { workspaces, loaded, load, select } = useWorkspaceStore();

  useEffect(() => {
    void load();
  }, [load]);

  const sortedWorkspaces = useMemo(
    () =>
      [...workspaces].sort(
        (a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name),
      ),
    [workspaces],
  );

  const panelWidth = showWorkspaceList ? '16.5rem' : '0';

  return (
    <TooltipProvider delayDuration={200}>
      <div className="h-full flex flex-shrink-0">
        <nav className="w-[4.5rem] h-full bg-muted/30 flex flex-col items-center py-3 gap-1 flex-shrink-0">
          <div className="w-11 h-11 rounded-xl overflow-hidden mb-3 flex-shrink-0 flex items-center justify-center">
            <img
              src={`${import.meta.env.BASE_URL}loading-logo.svg`}
              alt="智牧工作台"
              className="w-full h-full object-cover"
            />
          </div>

          {navItems.map(({ path, icon: Icon, label }) => {
            const isChatItem = path === '/chat';
            const isActive = location.pathname.startsWith(path);
            const baseClass =
              'w-12 h-12 rounded-xl flex flex-col items-center justify-center gap-0.5 transition-colors';
            const activeClass = isActive
              ? 'bg-brand-50 text-primary'
              : 'text-muted-foreground hover:bg-accent';

            return (
              <Tooltip key={path}>
                <TooltipTrigger asChild>
                  {isChatItem && isChatRoute ? (
                    <button
                      onClick={onToggleCollapse}
                      className={cn(baseClass, activeClass)}
                    >
                      <Icon
                        className="w-[20px] h-[20px]"
                        strokeWidth={isActive ? 2 : 1.75}
                      />
                      <span className="text-[10px] leading-tight">{label}</span>
                    </button>
                  ) : (
                    <NavLink to={path} className={cn(baseClass, activeClass)}>
                      <Icon
                        className="w-[20px] h-[20px]"
                        strokeWidth={isActive ? 2 : 1.75}
                      />
                      <span className="text-[10px] leading-tight">{label}</span>
                    </NavLink>
                  )}
                </TooltipTrigger>
                <TooltipContent side="right">
                  {isChatItem && isChatRoute
                    ? collapsed
                      ? '展开工作台'
                      : '收起工作台'
                    : label}
                </TooltipContent>
              </Tooltip>
            );
          })}

          {/* Spacer */}
          <div className="flex-1" />

          {/* User avatar popover */}
          <Popover>
            <PopoverTrigger asChild>
              <button className="rounded-full hover:ring-2 hover:ring-brand-200 transition-all cursor-pointer mb-2">
                <div className="w-8 h-8 rounded-full bg-primary/15 flex items-center justify-center text-sm font-semibold text-primary">
                  {userInitial}
                </div>
              </button>
            </PopoverTrigger>
            <PopoverContent side="right" align="end" className="w-44 p-1">
              <div className="px-3 py-2 text-xs font-medium text-muted-foreground truncate border-b border-border mb-1">
                {user?.displayName || user?.username}
              </div>
              <button
                onClick={() => navigate('/settings')}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm rounded-md hover:bg-accent text-foreground cursor-pointer"
              >
                <UserCog className="w-4 h-4" /> 个人设置
              </button>
              <button
                onClick={async () => {
                  await useAuthStore.getState().logout();
                  navigate('/login');
                }}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm rounded-md hover:bg-destructive/10 text-destructive cursor-pointer"
              >
                <LogOut className="w-4 h-4" /> 退出登录
              </button>
            </PopoverContent>
          </Popover>
        </nav>

        <div
          className="h-full overflow-hidden transition-[width] duration-200 ease-linear"
          style={{ width: panelWidth }}
        >
          <div className="w-[16.5rem] h-full flex flex-col bg-muted/30">
            <div className="flex items-center gap-2 px-4 pt-6 pb-3 mb-3 flex-shrink-0">
              <img
                src={`${import.meta.env.BASE_URL}logo-text.svg`}
                alt="智牧工作台"
                className="h-10"
              />
              <div className="flex-1" />
              <button
                onClick={onToggleCollapse}
                className="w-7 h-7 rounded-lg flex items-center justify-center hover:bg-accent text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
              >
                <PanelLeftClose className="w-4 h-4" />
              </button>
            </div>

            {/* Workspace list */}
            <div className="flex-1 overflow-y-auto px-1.5">
              {!loaded && sortedWorkspaces.length === 0 ? (
                <SkeletonCardList count={4} compact />
              ) : sortedWorkspaces.length === 0 ? (
                <div className="flex h-32 flex-col items-center justify-center px-4">
                  <p className="text-center text-xs text-muted-foreground">
                    暂无工作区
                  </p>
                </div>
              ) : (
                <div className="pt-1 pb-3">
                  <h2 className="px-3 pb-1 pt-1 text-[10px] font-medium tracking-[0.08em] text-muted-foreground">
                    我的工作区
                  </h2>
                  {sortedWorkspaces.map((ws) => (
                    <button
                      key={ws.id}
                      type="button"
                      onClick={() => {
                        if (!ws.active) void select(ws.id);
                      }}
                      className={cn(
                        'w-full flex items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors cursor-pointer',
                        ws.active
                          ? 'bg-brand-50 text-primary font-medium'
                          : 'text-foreground/80 hover:bg-accent',
                      )}
                    >
                      <span
                        className={cn(
                          'h-1.5 w-1.5 shrink-0 rounded-full',
                          ws.active ? 'bg-primary' : 'bg-muted-foreground/30',
                        )}
                      />
                      <span className="min-w-0 flex-1 truncate">{ws.name}</span>
                      {ws.role !== 'member' && (
                        <span className="shrink-0 text-[10px] text-muted-foreground">
                          {ws.role === 'owner' ? 'Owner' : 'Admin'}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
