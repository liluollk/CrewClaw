import { lazy, Suspense } from 'react';
import {
  Navigate,
  Route,
  RouterProvider,
  createBrowserRouter,
  createRoutesFromElements,
} from 'react-router-dom';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { AuthGuard } from './components/auth/AuthGuard';
import { AppLayout } from './components/layout/AppLayout';
import { Toaster } from '@/components/ui/sonner';

const ChatPage = lazy(() =>
  import('./pages/ChatPage').then((m) => ({ default: m.ChatPage })),
);
const TasksPage = lazy(() =>
  import('./pages/TasksPage').then((m) => ({ default: m.TasksPage })),
);
const MemoryPage = lazy(() =>
  import('./pages/MemoryPage').then((m) => ({ default: m.MemoryPage })),
);
const SettingsPage = lazy(() =>
  import('./pages/SettingsPage').then((m) => ({ default: m.SettingsPage })),
);

function PageFallback() {
  return (
    <div
      className="flex h-full items-center justify-center text-sm text-muted-foreground motion-safe:animate-pulse"
      role="status"
      aria-live="polite"
    >
      正在加载…
    </div>
  );
}

const appRoutes = createRoutesFromElements(
  <>
    {/* Public Routes */}
    <Route path="/login" element={<LoginPage />} />
    <Route path="/register" element={<RegisterPage />} />

    {/* Protected Routes with Layout */}
    <Route
      element={
        <AuthGuard>
          <AppLayout />
        </AuthGuard>
      }
    >
      <Route
        path="/chat"
        element={
          <Suspense fallback={<PageFallback />}>
            <ChatPage />
          </Suspense>
        }
      />
      <Route
        path="/tasks"
        element={
          <Suspense fallback={<PageFallback />}>
            <TasksPage />
          </Suspense>
        }
      />
      <Route
        path="/memory"
        element={
          <Suspense fallback={<PageFallback />}>
            <MemoryPage />
          </Suspense>
        }
      />
      <Route
        path="/settings"
        element={
          <Suspense fallback={<PageFallback />}>
            <SettingsPage />
          </Suspense>
        }
      />
      <Route path="/groups" element={<Navigate to="/chat" replace />} />
    </Route>

    {/* Default redirect */}
    <Route path="/" element={<Navigate to="/chat" replace />} />
    <Route path="*" element={<Navigate to="/chat" replace />} />
  </>,
);

export function App() {
  return (
    <>
      <Toaster position="top-right" richColors />
      <RouterProvider router={createBrowserRouter(appRoutes)} />
    </>
  );
}
