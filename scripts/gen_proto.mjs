#!/usr/bin/env node
// 跨平台 proto 代码生成器（Node >= 18，零第三方依赖）。
//
// 为什么不用 protoc 直接拉起 ts-proto 插件：
//   Windows 上 protoc 会经 cmd.exe 拉起插件，若系统配置了 cmd AutoRun，
//   其输出会污染插件 stdout（CodeGeneratorResponse 是二进制 protobuf），
//   导致 "Plugin output is unparseable"。这里改为「protoc 出 descriptor_set，
//   再用当前 node 直接 spawn ts-proto 的 plugin.js」，全程不经 shell，三平台一致。
//
// 用法：
//   node scripts/gen_proto.mjs web [--from-install]   生成 TS（apps/web/src/proto）
//   node scripts/gen_proto.mjs python                 生成 Python gRPC 桩（调 gen_python_proto.py）
//   node scripts/gen_proto.mjs all [--from-install]
//
// 环境变量：
//   PROTOC  protoc 可执行文件路径（缺省时从 PATH 查找 protoc / protoc.exe）
//   PYTHON  带 grpcio-tools 的解释器（缺省探测 python3 / python）
//
// --from-install：作为 postinstall 运行时，缺工具只告警不失败（避免阻断依赖安装）。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROTO_DIR = path.join(ROOT, 'proto');
const WEB_DIR = path.join(ROOT, 'apps', 'web');
const WEB_OUT = path.join(WEB_DIR, 'src', 'proto');
const TS_PROTO_PLUGIN = path.join(WEB_DIR, 'node_modules', 'ts-proto', 'build', 'src', 'plugin.js');
const TS_PROTO_OPTIONS =
  'esModuleInterop=true,outputServices=generic-definitions,outputClientImpl=false,useOptionals=messages,fileSuffix=.gen';

class MissingToolError extends Error {}

function log(msg) {
  console.log(`[gen-proto] ${msg}`);
}
function warn(msg) {
  console.warn(`[gen-proto] WARN: ${msg}`);
}
function die(msg) {
  console.error(`[gen-proto] error: ${msg}`);
  process.exit(1);
}

/** 在 PATH 上查找可执行文件（Windows 按 PATHEXT 补扩展名）。 */
function which(cmd) {
  const isAbsoluteExe = path.isAbsolute(cmd);
  if (isAbsoluteExe) {
    try {
      if (fs.statSync(cmd).isFile()) return cmd;
    } catch {
      /* fall through */
    }
    return null;
  }
  const extensions =
    process.platform === 'win32'
      ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(path.delimiter).filter(Boolean)
      : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of extensions) {
      const candidate = path.join(dir, cmd + ext.toLowerCase());
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        /* next */
      }
    }
  }
  return null;
}

function resolveProtoc() {
  const configured = process.env.PROTOC?.trim();
  if (configured) {
    const found = which(configured) ?? (fs.existsSync(configured) ? configured : null);
    if (found) return found;
    throw new MissingToolError(
      `环境变量 PROTOC=${configured} 指向的文件不存在；请安装 protoc 或修正 PROTOC`,
    );
  }
  const found = which('protoc');
  if (found) return found;
  throw new MissingToolError(
    'PATH 中找不到 protoc。请安装 protobuf 编译器（macOS: brew install protobuf；' +
      'Linux: 系统包 protobuf-compiler；Windows: 下载 protoc 后加入 PATH 或设置 PROTOC 环境变量）',
  );
}

/** 递归收集 proto/ 下所有 .proto，返回 POSIX 风格相对名（如 music/v1/events.proto）。 */
function collectProtoFiles() {
  if (!fs.existsSync(PROTO_DIR)) {
    die(`proto 目录不存在：${PROTO_DIR}`);
  }
  const names = [];
  for (const entry of walkSync(PROTO_DIR)) {
    if (entry.endsWith('.proto')) {
      names.push(path.relative(PROTO_DIR, entry).split(path.sep).join('/'));
    }
  }
  if (names.length === 0) die(`未在 ${PROTO_DIR} 发现任何 .proto 文件`);
  return names.sort();
}
function* walkSync(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) yield* walkSync(full);
    else yield full;
  }
}

// ---- 极简 protobuf 线格式编解码（仅覆盖插件协议用到的 wire type）----

function varintBytes(n) {
  const out = [];
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n = Number(BigInt(n) >> 7n);
  }
  out.push(n & 0x7f);
  return Buffer.from(out);
}
function fieldBytes(field, payload) {
  return Buffer.concat([varintBytes((field << 3) | 2), varintBytes(payload.length), payload]);
}
function readVarint(buf, state) {
  let result = 0n;
  let shift = 0n;
  for (;;) {
    const byte = buf[state.i++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7n;
  }
  return Number(result);
}

/** 从 FileDescriptorSet 抽出 field 1 的各 FileDescriptorProto 原始字节。 */
function extractDescriptorFiles(setBytes) {
  const files = [];
  const state = { i: 0 };
  while (state.i < setBytes.length) {
    const tag = setBytes[state.i++];
    const field = tag >> 3;
    const wire = tag & 7;
    if (wire !== 2) throw new Error('descriptor_set 中出现意外的 wire type');
    const len = readVarint(setBytes, state);
    const chunk = Buffer.from(setBytes.subarray(state.i, state.i + len));
    state.i += len;
    if (field === 1) files.push(chunk);
  }
  return files;
}

/** 解析 CodeGeneratorResponse：field 1=error，field 2=supported_features(varint)，field 15=file。 */
function parseGeneratorResponse(resp) {
  const out = [];
  let errorMsg = '';
  const state = { i: 0 };
  while (state.i < resp.length) {
    const tag = resp[state.i++];
    const field = tag >> 3;
    const wire = tag & 7;
    if (wire === 2) {
      const len = readVarint(resp, state);
      const chunk = resp.subarray(state.i, state.i + len);
      state.i += len;
      if (field === 1) errorMsg += chunk.toString('utf8');
      if (field === 15) {
        let name = '';
        let content = '';
        const inner = { i: 0 };
        while (inner.i < chunk.length) {
          const ctag = chunk[inner.i++];
          const cfield = ctag >> 3;
          const cwire = ctag & 7;
          const clen = readVarint(chunk, inner);
          const payload = chunk.subarray(inner.i, inner.i + clen);
          inner.i += clen;
          if (cwire === 2 && cfield === 1) name = payload.toString('utf8');
          if (cwire === 2 && cfield === 15) content = payload.toString('utf8');
        }
        out.push({ name, content });
      }
    } else if (wire === 0) {
      readVarint(resp, state); // supported_features
    } else if (wire === 1) {
      state.i += 8;
    } else if (wire === 5) {
      state.i += 4;
    } else {
      throw new Error(`CodeGeneratorResponse 中出现意外的 wire type: ${wire}`);
    }
  }
  return { errorMsg, files: out };
}

function generateWeb() {
  if (!fs.existsSync(TS_PROTO_PLUGIN)) {
    throw new MissingToolError(
      `ts-proto 未安装（${path.relative(ROOT, TS_PROTO_PLUGIN)} 不存在），请先在 apps/web 执行 pnpm install`,
    );
  }
  const protoc = resolveProtoc();
  const protoNames = collectProtoFiles();

  // 1) protoc -> 二进制 FileDescriptorSet（--include_imports 兼容将来引入内置 proto）
  const descFile = path.join(
    os.tmpdir(),
    `music-agent-descriptor-${process.pid}-${Date.now()}.bin`,
  );
  try {
    const protocArgs = [
      `-I${PROTO_DIR}`,
      `--descriptor_set_out=${descFile}`,
      '--include_imports',
      ...protoNames,
    ];
    const r = spawnSync(protoc, protocArgs, { stdio: ['ignore', 'inherit', 'inherit'] });
    if (r.error) {
      throw r.error.code === 'ENOENT'
        ? new MissingToolError(`无法执行 protoc：${protoc}`)
        : r.error;
    }
    if (r.status !== 0) die('protoc 生成 descriptor_set 失败');

    // 2) 组装 CodeGeneratorRequest，直接用当前 node 拉起 ts-proto（不经 shell）
    const descriptorFiles = extractDescriptorFiles(fs.readFileSync(descFile));
    const parts = [];
    for (const name of protoNames) parts.push(fieldBytes(1, Buffer.from(name)));
    parts.push(fieldBytes(2, Buffer.from(TS_PROTO_OPTIONS)));
    for (const f of descriptorFiles) parts.push(fieldBytes(15, f));
    const request = Buffer.concat(parts);

    const plugin = spawnSync(process.execPath, [TS_PROTO_PLUGIN], {
      input: request,
      maxBuffer: 256 * 1024 * 1024,
    });
    if (plugin.error) die(`拉起 ts-proto 插件失败：${plugin.error.message}`);
    if (plugin.status !== 0) {
      process.stderr.write(plugin.stderr);
      die('ts-proto 插件执行失败');
    }

    const { errorMsg, files } = parseGeneratorResponse(plugin.stdout);
    if (errorMsg) die(`ts-proto 返回错误：${errorMsg}`);
    if (files.length === 0) die('ts-proto 未返回任何文件');

    // 3) 按响应中的相对路径写出（name 形如 music/v1/events.gen.ts）
    fs.mkdirSync(WEB_OUT, { recursive: true });
    for (const f of files) {
      const target = path.join(WEB_OUT, f.name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, f.content);
      log(`web <- ${path.relative(ROOT, target).split(path.sep).join('/')}`);
    }
    log(`web proto 生成完成（protoc: ${protoc}）`);
  } finally {
    try {
      fs.rmSync(descFile, { force: true });
    } catch {
      /* 临时文件清理失败可忽略 */
    }
  }
}

/** 探测带 grpcio-tools 的 Python 解释器。 */
function resolvePython() {
  const candidates = process.env.PYTHON?.trim()
    ? [process.env.PYTHON.trim()]
    : ['python3', 'python'];
  for (const candidate of candidates) {
    const exe = path.isAbsolute(candidate) ? candidate : which(candidate) ?? candidate;
    const r = spawnSync(exe, ['-c', 'import grpc_tools; print(1)'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (r.status === 0 && r.stdout.trim() === '1') return exe;
  }
  throw new MissingToolError(
    '找不到带 grpcio-tools 的 Python（已尝试 $PYTHON / python3 / python）。' +
      '请安装依赖：pip install grpcio grpcio-tools，或用 PYTHON=/path/to/python 指定解释器',
  );
}

function generatePython() {
  const py = resolvePython();
  const script = path.join(ROOT, 'scripts', 'gen_python_proto.py');
  const r = spawnSync(py, [script], { stdio: 'inherit' });
  if (r.error) die(`执行 Python 生成器失败：${r.error.message}`);
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function usage() {
  console.error('用法: node scripts/gen_proto.mjs <web|python|all> [--from-install]');
  process.exit(2);
}

const [command, ...rest] = process.argv.slice(2);
const fromInstall = rest.includes('--from-install');

if (!['web', 'python', 'all'].includes(command)) usage();

try {
  if (command === 'web' || command === 'all') generateWeb();
  if (command === 'python' || command === 'all') generatePython();
} catch (err) {
  if (fromInstall && err instanceof MissingToolError) {
    // postinstall 场景：缺工具不应阻断 pnpm install；手动执行 `pnpm proto` 会严格报错。
    warn(`${err.message}`);
    warn('已跳过 proto 生成；补齐工具后执行 `pnpm proto`（或 node scripts/gen_proto.mjs all）。');
    process.exit(0);
  }
  die(err instanceof Error ? err.message : String(err));
}
