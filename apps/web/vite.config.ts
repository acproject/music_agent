import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 开发期同源代理：浏览器只与 :5173 通信，REST/WS 均转发到 Rust 网关 :8080
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/health': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: true,
      },
      '/api': {
        target: 'http://127.0.0.1:8080',
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
