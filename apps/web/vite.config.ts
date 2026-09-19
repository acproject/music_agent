import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { generate } from 'selfsigned';
// @ts-expect-error Node 内置模块；项目未安装 @types/node，运行时由 Vite 外部化
import { networkInterfaces } from 'node:os';

// 开发期同源代理：浏览器只与 :5173 通信，REST/WS 均转发到 Rust 网关 :8080
//
// 麦克风（getUserMedia）只在安全上下文开放：localhost 天然可用；
// 平板/手机通过局域网 IP 访问时，需以 DEV_HTTPS=1 启动：
// 启动时动态生成自签证书，SAN 覆盖 localhost 与当前所有局域网 IPv4，
// 首次在平板浏览器打开 https://<本机IP>:5173 时点“继续访问/信任”即可。

const nodeEnv = (
  globalThis as { process?: { env?: Record<string, string | undefined> } }
).process?.env;
const useHttps = nodeEnv?.DEV_HTTPS === '1' || nodeEnv?.DEV_HTTPS === 'true';

function lanIPv4s(): string[] {
  const ips = new Set<string>();
  const interfaces = networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const ni of interfaces[name] ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) {
        ips.add(ni.address);
      }
    }
  }
  return [...ips];
}

async function buildHttpsOptions() {
  const pems = await generate(
    [{ name: 'commonName', value: 'music-agent-dev' }],
    {
      keySize: 2048,
      algorithm: 'sha256',
      extensions: [
        { name: 'basicConstraints', cA: false },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
        { name: 'extKeyUsage', serverAuth: true, clientAuth: true },
        {
          name: 'subjectAltName',
          altNames: [
            { type: 2, value: 'localhost' },
            { type: 7, ip: '127.0.0.1' },
            ...lanIPv4s().map((ip) => ({ type: 7 as const, ip })),
          ],
        },
      ],
    },
  );
  return { key: pems.private, cert: pems.cert };
}

export default defineConfig(async () => ({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    https: useHttps ? await buildHttpsOptions() : undefined,
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
}));
