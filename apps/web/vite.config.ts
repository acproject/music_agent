import { defineConfig, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

// 开发期同源代理：浏览器只与 :5173 通信，REST/WS 均转发到 Rust 网关 :8080
//
// 麦克风（getUserMedia）只在安全上下文开放：localhost 天然可用；
// 平板/手机通过局域网 IP 访问时，需以 DEV_HTTPS=1 启动，得到自签 HTTPS 地址。
const nodeEnv = (
  globalThis as { process?: { env?: Record<string, string | undefined> } }
).process?.env;
const useHttps = nodeEnv?.DEV_HTTPS === '1' || nodeEnv?.DEV_HTTPS === 'true';

const plugins: PluginOption[] = [react()];
if (useHttps) {
  plugins.push(basicSsl());
}

export default defineConfig({
  plugins,
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
