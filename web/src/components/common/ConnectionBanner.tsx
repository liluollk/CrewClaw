import { useEffect, useState } from 'react';
import { WifiOff } from 'lucide-react';

/** 断网横幅：无长连接，仅监测浏览器在线状态 */
export function ConnectionBanner() {
  const [offline, setOffline] = useState(!navigator.onLine);

  useEffect(() => {
    const on = () => setOffline(false);
    const off = () => setOffline(true);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  if (!offline) return null;
  return (
    <div className="flex items-center justify-center gap-2 bg-destructive/90 px-4 py-1.5 text-sm text-white">
      <WifiOff className="size-4" /> 网络已断开，正在等待恢复…
    </div>
  );
}
