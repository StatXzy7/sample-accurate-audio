/**
 * server.test.js — 静态服务器：--port 0 自动端口、页面与模块可达、路径穿越被拒。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer } from '../src/server.js';

function get(port, host, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host, port, path }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
  });
}

const host = '127.0.0.1';
const started = await startServer(0, host);
after(() => started.server.close());

test('--port 0：操作系统分配了真实端口', () => {
  assert.ok(Number.isInteger(started.port) && started.port > 0, `实际端口异常：${started.port}`);
});

test('GET / 返回 index.html', async () => {
  const res = await get(started.port, host, '/');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.match(res.body.toString('utf8'), /语音片段工作台/);
});

test('静态资源：styles.css / app.js 可访问', async () => {
  const css = await get(started.port, host, '/styles.css');
  assert.equal(css.status, 200);
  assert.match(css.headers['content-type'], /text\/css/);

  const js = await get(started.port, host, '/app.js');
  assert.equal(js.status, 200);
  assert.match(js.headers['content-type'], /javascript/);
});

test('/core/* 暴露浏览器用核心模块', async () => {
  const res = await get(started.port, host, '/core/clips.js');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /javascript/);
  assert.match(res.body.toString('utf8'), /renderClips/);
});

test('路径穿越被拒绝（403/404，不泄露文件系统）', async () => {
  const encoded = '/..%2f..%2f..%2f..%2fwindows%2fwin.ini';
  const res = await get(started.port, host, encoded);
  assert.ok([403, 404].includes(res.status), `期望 403/404，实际 ${res.status}`);
});

test('不存在的文件返回 404', async () => {
  const res = await get(started.port, host, '/nope.txt');
  assert.equal(res.status, 404);
});

test('POST 不被允许（405）', async () => {
  const result = await new Promise((resolve) => {
    const req = http.request({ host, port: started.port, path: '/', method: 'POST' }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.end();
  });
  assert.equal(result, 405);
});

test('畸形百分号编码返回 400 且不崩溃进程（回归：单请求打挂服务器）', async () => {
  const res1 = await get(started.port, host, '/%zz');
  assert.equal(res1.status, 400);
  // 服务器仍然存活，可继续正常服务
  const res2 = await get(started.port, host, '/%ff%fe');
  assert.equal(res2.status, 400);
  const res3 = await get(started.port, host, '/');
  assert.equal(res3.status, 200);
});

test('HEAD 只返回响应头，不携带响应体', async () => {
  const res = await new Promise((resolve, reject) => {
    const req = http.request({ host, port: started.port, path: '/app.js', method: 'HEAD' }, (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(res.status, 200);
  assert.ok(Number(res.headers['content-length']) > 0, '应声明 Content-Length');
  assert.equal(res.body.length, 0, 'HEAD 响应体必须为空');
});
