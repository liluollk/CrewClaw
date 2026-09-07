import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// 开发：vite dev（5173）代理 /api 到 Hono（3000）；生产：dist/ 由 Hono 静态托管
export default defineConfig({
  base: '/',
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    host: '0.0.0.0',
    strictPort: true,
    proxy: { '/api': process.env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:3000' },
  },
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  build: { outDir: 'dist', emptyOutDir: true },
});
