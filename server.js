/**
 * 零依赖静态文件服务器（仅 Node.js 内置能力，Windows 可运行）。
 *
 * 用法：
 *   npm start                         默认 127.0.0.1:8000
 *   node server.js --port 3000
 *   node server.js --port 0           由系统分配空闲端口，并打印实际地址
 *   node server.js --port 0 --host 127.0.0.1
 */
import http from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 8000;
const DEFAULT_HOST = '127.0.0.1';

const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon'],
  ['.wav', 'audio/wav'],
]);

function parseArgs(argv) {
  const opts = { port: DEFAULT_PORT, host: DEFAULT_HOST };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const readValue = (inline) => {
      if (inline !== undefined) return inline;
      i += 1;
      if (argv[i] === undefined) throw new Error(`${arg} 缺少值`);
      return argv[i];
    };
    if (arg === '--port' || arg === '-p') {
      opts.port = Number(readValue());
    } else if (arg.startsWith('--port=')) {
      opts.port = Number(arg.slice('--port='.length));
    } else if (arg === '--host' || arg === '-h') {
      opts.host = readValue();
    } else if (arg.startsWith('--host=')) {
      opts.host = arg.slice('--host='.length);
    } else if (arg === '--help') {
      opts.help = true;
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) {
    throw new Error(`端口无效：${opts.port}（需要 0..65535 的整数，0 表示自动分配）`);
  }
  return opts;
}

/** 仅允许访问项目目录内文件，阻止路径穿越。 */
function resolveSafePath(urlPathname) {
  const decoded = decodeURIComponent(urlPathname.split('?')[0]);
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const abs = path.normalize(path.join(ROOT, relative));
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) {
    return null;
  }
  return abs;
}

const server = http.createServer((req, res) => {
  const onError = (status, message) => {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`${status} ${message}\n`);
  };

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return onError(405, 'Method Not Allowed');
  }

  const abs = resolveSafePath(req.url);
  if (!abs) return onError(403, 'Forbidden');

  const ext = path.extname(abs).toLowerCase();
  const type = MIME.get(ext) ?? 'application/octet-stream';

  // 大文件走流式发送；这里先 stat 以确认存在且不是目录
  res.setHeader('Content-Type', type);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');

  let stat;
  try {
    stat = statSync(abs);
  } catch {
    return onError(404, 'Not Found');
  }
  if (stat.isDirectory()) return onError(404, 'Not Found');

  res.setHeader('Content-Length', stat.size);
  if (req.method === 'HEAD') {
    res.writeHead(200);
    return res.end();
  }
  res.writeHead(200);
  createReadStream(abs)
    .on('error', () => {
      if (!res.headersSent) onError(500, 'Internal Server Error');
      else res.destroy();
    })
    .pipe(res);
});

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write('用法: node server.js [--port 0..65535] [--host 地址]\n');
  process.exit(0);
}

server.on('error', (err) => {
  process.stderr.write(`服务器启动失败：${err.message}\n`);
  process.exit(1);
});

server.listen(args.port, args.host, () => {
  const { port } = server.address();
  process.stdout.write(`采样精确音频整理工具已启动：\n  http://${args.host}:${port}/\n`);
  process.stdout.write(`静态目录：${ROOT}\n（Ctrl+C 停止）\n`);
});
