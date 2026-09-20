/**
 * server.js — 零依赖静态文件服务器（Node 内置 http/fs/path/url）。
 *
 * 用法：
 *   node src/server.js [--port 8080] [--host 127.0.0.1]
 *
 * --port 0 时由操作系统分配空闲端口，服务器启动后打印实际监听地址。
 * 不依赖任何音频编解码外部程序；浏览器端全部使用原生 Web API 处理音频。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
// core 模块通过 /core/* 虚拟路径暴露给浏览器 import
const CORE_DIR = path.join(__dirname, 'core');

const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon'],
]);

function parseArgs(argv) {
  const args = { port: 8080, host: '127.0.0.1' };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--port') {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value < 0 || value > 65535) {
        throw new Error(`--port 需要 0-65535 的整数，收到 "${argv[i + 1]}"`);
      }
      args.port = value;
      i += 1;
    } else if (token.startsWith('--port=')) {
      const value = Number(token.slice('--port='.length));
      if (!Number.isInteger(value) || value < 0 || value > 65535) {
        throw new Error(`--port 需要 0-65535 的整数，收到 "${token.slice('--port='.length)}"`);
      }
      args.port = value;
    } else if (token === '--host') {
      args.host = argv[i + 1];
      i += 1;
    } else if (token === '--help' || token === '-h') {
      args.help = true;
    } else {
      throw new Error(`未知参数：${token}`);
    }
  }
  return args;
}

/** 防止路径穿越：规范化后必须仍位于基准目录内。 */
function safeResolve(baseDir, urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const resolved = path.normalize(path.join(baseDir, decoded));
  const rel = path.relative(baseDir, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return null;
  }
  return resolved;
}

function sendFile(res, filePath, method) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(method === 'HEAD' ? undefined : '404 Not Found');
      return;
    }
    const type = MIME.get(path.extname(filePath).toLowerCase()) ?? 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': Buffer.byteLength(data),
    });
    // HEAD 只返回响应头，不携带响应体
    res.end(method === 'HEAD' ? undefined : data);
  });
}

function sendText(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(message);
}

export function createRequestHandler() {
  return function handler(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      sendText(res, 400, '400 Bad Request');
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendText(res, 405, '405 Method Not Allowed');
      return;
    }

    let filePath;
    try {
      if (url.pathname === '/') {
        filePath = path.join(PUBLIC_DIR, 'index.html');
      } else if (url.pathname.startsWith('/core/')) {
        filePath = safeResolve(CORE_DIR, url.pathname.slice('/core/'.length));
        // 核心目录仅暴露 .js 模块
        if (filePath && path.extname(filePath) !== '.js') filePath = null;
      } else {
        filePath = safeResolve(PUBLIC_DIR, url.pathname.slice(1));
      }
    } catch {
      // 畸形百分号编码会令 decodeURIComponent 抛 URIError —— 请求级错误不得杀进程
      sendText(res, 400, '400 Bad Request');
      return;
    }

    if (filePath === null) {
      sendText(res, 403, '403 Forbidden');
      return;
    }
    sendFile(res, filePath, req.method);
  };
}

export function startServer(port = 8080, host = '127.0.0.1') {
  const server = http.createServer(createRequestHandler());
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      resolve({ server, port: actualPort, host });
    });
  });
}

function printHelp() {
  process.stdout.write('用法: node src/server.js [--port 8080] [--host 127.0.0.1]\n');
  process.stdout.write('  --port 0 由操作系统分配空闲端口\n');
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }
  const { server, port, host } = await startServer(args.port, args.host);
  process.stdout.write(`语音片段工作台已启动：http://${host}:${port}/\n`);

  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// 仅作为入口脚本运行时启动（被测试 import 时不自动监听）
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });
}
