import { useEffect, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../../stores/auth';
import { LogoLoading } from '../common/LogoLoading';

interface AuthGuardProps {
  children: ReactNode;
}

/** 登录态守卫（无权限点/setup 分支） */
export function AuthGuard({ children }: AuthGuardProps) {
  const navigate = useNavigate();
  const {
    authenticated,
    initialized,
    checking,
    checkAuth,
  } = useAuthStore();

  useEffect(() => {
    if (initialized === null) {
      void checkAuth();
    }
  }, [initialized, checkAuth]);

  useEffect(() => {
    if (initialized !== null && !checking && !authenticated) {
      navigate('/login', { replace: true });
    }
  }, [initialized, checking, authenticated, navigate]);

  // 放行前整棵已登录子树都不渲染
  if (initialized !== true || !authenticated) {
    return <LogoLoading full />;
  }

  return <>{children}</>;
}
