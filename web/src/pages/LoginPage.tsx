import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useAuthStore } from '../stores/auth';
import { extractErrorMessage } from '../utils/error';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';

type Tab = 'login' | 'register';

/** 登录/注册页（无邀请码/setup 向导/强制改密） */
export function LoginPage() {
  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState<Tab>(
    searchParams.get('tab') === 'register' ? 'register' : 'login',
  );
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const login = useAuthStore((state) => state.login);
  const register = useAuthStore((state) => state.register);

  // Login fields
  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');

  // Register fields
  const [regUsername, setRegUsername] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [regDisplayName, setRegDisplayName] = useState('');

  const switchTab = (t: Tab) => {
    setTab(t);
    setError('');
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      await login(loginUsername, loginPassword);
      navigate('/chat', { replace: true });
    } catch (err) {
      setError(extractErrorMessage(err) || '登录失败');
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!/^[a-zA-Z0-9_-]{2,32}$/.test(regUsername)) {
      setError('用户名须为 2-32 位字母、数字、下划线或中划线');
      return;
    }
    if (regPassword.length < 8) {
      setError('密码长度不能少于 8 位');
      return;
    }

    setLoading(true);
    try {
      await register({
        username: regUsername,
        password: regPassword,
        displayName: regDisplayName || undefined,
      });
      navigate('/chat', { replace: true });
    } catch (err) {
      setError(extractErrorMessage(err) || '注册失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="landing-page min-h-screen bg-background overflow-y-auto relative">
      {/* ── Background noise grain ── */}
      <div className="landing-gradient-bg" aria-hidden="true" />

      {/* ── Aurora blobs ── */}
      <div className="landing-aurora" aria-hidden="true">
        <div className="landing-aurora-blob landing-aurora-blob-1" />
        <div className="landing-aurora-blob landing-aurora-blob-2" />
        <div className="landing-aurora-blob landing-aurora-blob-3" />
        <div className="landing-aurora-blob landing-aurora-blob-4" />
      </div>

      {/* ── Top nav bar ── */}
      <header className="relative z-10 flex items-center justify-between px-6 py-4 lg:px-12">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl overflow-hidden flex items-center justify-center">
            <img
              src={`${import.meta.env.BASE_URL}loading-logo.svg`}
              alt="智牧工作台"
              className="w-full h-full object-cover"
            />
          </div>
          <span className="text-lg font-semibold text-foreground tracking-tight">
            智牧工作台
          </span>
        </div>
      </header>

      {/* ── Hero + Auth section ── */}
      <main className="relative z-10 px-5 sm:px-6 lg:px-12 pt-4 pb-8 lg:pt-16 lg:pb-16 flex-1 flex items-start lg:items-center">
        <div className="mx-auto max-w-6xl w-full">
          {/* Mobile: card-first compact layout / Desktop: side-by-side */}
          <div className="flex flex-col-reverse lg:grid lg:grid-cols-2 gap-8 lg:gap-20 items-center lg:items-start lg:pt-12">
            {/* Left: Hero text — below card on mobile */}
            <div className="text-center lg:text-left">
              <h1 className="text-3xl sm:text-4xl lg:text-6xl font-bold text-foreground tracking-tight leading-[1.1]">
                把猪场的日常
                <br />
                <span className="landing-gradient-text">交给数字员工</span>
              </h1>

              <p className="mt-4 lg:mt-6 text-sm sm:text-base lg:text-lg text-muted-foreground leading-relaxed max-w-lg mx-auto lg:mx-0">
                在 Web 和飞书/钉钉群里，一句话完成生产协作闭环。
              </p>

              {/* Stats — hidden on small mobile to save space */}
              <div className="mt-6 lg:mt-8 hidden sm:flex items-center justify-center lg:justify-start gap-6 lg:gap-8">
                <div>
                  <div className="text-xl lg:text-2xl font-bold text-foreground">
                    猪舍指标
                  </div>
                  <div className="text-xs text-muted-foreground">实时可查</div>
                </div>
                <div className="w-px h-8 bg-border" />
                <div>
                  <div className="text-xl lg:text-2xl font-bold text-foreground">
                    健康异常
                  </div>
                  <div className="text-xs text-muted-foreground">当日上报</div>
                </div>
                <div className="w-px h-8 bg-border" />
                <div>
                  <div className="text-xl lg:text-2xl font-bold text-foreground">
                    复检任务
                  </div>
                  <div className="text-xs text-muted-foreground">闭环跟进</div>
                </div>
              </div>
            </div>

            {/* Right: Auth card — shown first on mobile */}
            <div className="flex justify-center lg:justify-end w-full">
              <div className="landing-glass-card w-full max-w-sm">
                {/* Logo */}
                <div className="flex justify-center mb-4 lg:mb-5">
                  <div className="w-12 h-12 lg:w-14 lg:h-14 rounded-2xl overflow-hidden shadow-lg flex items-center justify-center">
                    <img
                      src={`${import.meta.env.BASE_URL}loading-logo.svg`}
                      alt="智牧工作台"
                      className="w-full h-full object-cover"
                    />
                  </div>
                </div>

                <h2 className="text-lg lg:text-xl font-semibold text-foreground text-center mb-1">
                  {tab === 'login' ? '欢迎回来' : '注册新账户'}
                </h2>
                <p className="text-muted-foreground text-xs lg:text-sm text-center mb-5 lg:mb-6">
                  {tab === 'login'
                    ? '登录以继续使用智牧工作台'
                    : '创建你的账户'}
                </p>

                {error && (
                  <div
                    role="alert"
                    className="mb-4 p-3 bg-error-bg border border-error/30 rounded-lg text-left"
                  >
                    <p className="text-sm text-error">{error}</p>
                  </div>
                )}

                {/* ── Login form ── */}
                {tab === 'login' && (
                  <>
                    <form onSubmit={handleLogin} className="text-left">
                      <div className="mb-3 lg:mb-4">
                        <Label
                          htmlFor="login-username"
                          className="mb-1.5 text-sm"
                        >
                          用户名
                        </Label>
                        <Input
                          id="login-username"
                          type="text"
                          value={loginUsername}
                          onChange={(e) => setLoginUsername(e.target.value)}
                          placeholder="请输入用户名"
                          required
                          autoFocus
                          className="h-9 bg-background/50"
                        />
                      </div>

                      <div className="mb-5 lg:mb-6">
                        <Label
                          htmlFor="login-password"
                          className="mb-1.5 text-sm"
                        >
                          密码
                        </Label>
                        <Input
                          id="login-password"
                          type="password"
                          value={loginPassword}
                          onChange={(e) => setLoginPassword(e.target.value)}
                          placeholder="请输入密码"
                          required
                          className="h-9 bg-background/50"
                        />
                      </div>

                      <Button
                        type="submit"
                        disabled={loading}
                        className="w-full h-9"
                      >
                        {loading && <Loader2 className="size-4 animate-spin" />}
                        {loading ? '登录中...' : '登录'}
                      </Button>
                    </form>

                    <p className="text-center text-sm text-muted-foreground mt-4">
                      还没有账户？
                      <button
                        type="button"
                        onClick={() => switchTab('register')}
                        className="text-primary hover:text-primary/80 ml-1 font-medium"
                      >
                        去注册
                      </button>
                    </p>
                  </>
                )}

                {/* ── Register form ── */}
                {tab === 'register' && (
                  <>
                    <form onSubmit={handleRegister} className="text-left">
                      <div className="mb-3">
                        <Label
                          htmlFor="reg-username"
                          className="mb-1.5 text-sm"
                        >
                          用户名
                        </Label>
                        <Input
                          id="reg-username"
                          type="text"
                          value={regUsername}
                          onChange={(e) => setRegUsername(e.target.value)}
                          placeholder="2-32 位字母、数字、下划线或中划线"
                          required
                          autoFocus
                          className="h-9 bg-background/50"
                        />
                      </div>

                      <div className="mb-3">
                        <Label htmlFor="reg-display" className="mb-1.5 text-sm">
                          显示名称{' '}
                          <span className="text-muted-foreground font-normal">
                            (可选)
                          </span>
                        </Label>
                        <Input
                          id="reg-display"
                          type="text"
                          value={regDisplayName}
                          onChange={(e) => setRegDisplayName(e.target.value)}
                          placeholder="留空则使用用户名"
                          className="h-9 bg-background/50"
                        />
                      </div>

                      <div className="mb-5 lg:mb-6">
                        <Label
                          htmlFor="reg-password"
                          className="mb-1.5 text-sm"
                        >
                          密码
                        </Label>
                        <Input
                          id="reg-password"
                          type="password"
                          value={regPassword}
                          onChange={(e) => setRegPassword(e.target.value)}
                          placeholder="至少 8 位"
                          required
                          className="h-9 bg-background/50"
                        />
                      </div>

                      <Button
                        type="submit"
                        disabled={loading}
                        className="w-full h-9"
                      >
                        {loading && <Loader2 className="size-4 animate-spin" />}
                        {loading ? '注册中...' : '注册'}
                      </Button>
                    </form>

                    <p className="text-center text-sm text-muted-foreground mt-4">
                      已有账户？
                      <button
                        type="button"
                        onClick={() => switchTab('login')}
                        className="text-primary hover:text-primary/80 ml-1 font-medium"
                      >
                        去登录
                      </button>
                    </p>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
