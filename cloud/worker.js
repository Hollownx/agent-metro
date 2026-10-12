'use strict';
// 到站 · Agent Metro —— 云端看板（Cloudflare Worker）。
// 这是在公网上跑的同一套看板：台账文本存在 Durable Object 的存储里（单实例、请求串行，天然无并发冲突），
// 改台账的逻辑和本机是同一个 core（tools/ledger-core.js），所以「本机 ledger.js 改一行」和
// 「点网页改一行」行为完全一致，HISTORY.md、验收期、传送带全都照旧。
//
// 部署：node cloud/deploy.js（会先从本机台账打包 seed.json，再 wrangler deploy）
// 密码：npx wrangler secret put BOARD_PASSWORD —— 没设密码时全站 fail closed（一扇门也不开）。
// 跨设备同步的 CLI 在 tools/cloud-sync.js：push（本机 → 云端）/ pull（云端 → 本机）/ status / login。
//
// 同步语义（写在最前，别处的注释都指回这里）：
//   - 每次「网页点一下 / 一个文件推上来」版本号 +1，全部文件整体快照存进 rev:<版本号>，留最近 30 份；
//   - 本机 cloud-sync 里记着「我最后对齐过的版本」（.board-sync.json）；云端版本 > 本机记录 = 有别的设备写过，
//     这时普通 push/pull 会被拒（409），要么先对齐、要么 --force 两边选一头，防止静默互踩；
//   - DO 走经典 fetch() 转发（不用 RPC 基类），action 一个个 switch，实现在下面的 sendIntoDO。

import { applyToFiles, togglePinText } from '../tools/ledger-core.js';
import { buildDataFromParts, fillTemplate } from '../tools/build-metro-core.js';
import template from '../tools/metro-template.html';
import seedJson from './seed.json';

/* ---------- 常量 ---------- */

const COOKIE_NAME = 'am_board';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 180; // 180 天
const CSRF_TOKEN = 'cloud';       // 页面写请求带 X-Board-Token: cloud —— 自定义头跨域发不出去，挡掉异站表单 / 脚本
const REVISIONS_KEPT = 30;        // 同步语义里说的「留 30 份快照」就是这里
const MAX_FILE = 1024 * 1024;     // 单个台账文件 1MB 上限

// 三个 md + pins.json + projects/ 下的 .md。任务行的台账全在这几个白名单文件里，别的名字一概不收。
const BASE_FILES = ['TODO.md', 'ARCHIVE.md', 'HISTORY.md', 'pins.json'];

function isAllowedName(name) {
  if (typeof name !== 'string' || name.length > 200) return false;
  if (BASE_FILES.includes(name)) return true;
  const m = /^projects\/(.+)\.md$/.exec(name);
  return !!m && m[1].length > 0 && m[1].length < 100 && !m[1].includes('\\') && !m[1].startsWith('.');
}

/* ---------- 小工具 ---------- */

const json = (status, body, extra = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra },
});
const page = (status, html, extra = {}) => new Response(html, {
  status,
  headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra },
});
const plain = (status, body, extra = {}) => new Response(body, {
  status,
  headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra },
});

async function readJson(request) {
  const text = await request.text();
  if (text.length > 256 * 1024) throw new Error('请求太大');
  if (!text) return {};
  try { return JSON.parse(text); } catch (e) { throw new Error('请求不是合法 JSON'); }
}

async function hashOf(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return Array.from(new Uint8Array(buf).slice(0, 12)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

const pagesOf = (files) => {
  const pages = {};
  for (const [name, text] of Object.entries(files || {})) {
    const m = /^projects\/(.+)\.md$/.exec(name);
    if (m && m[1]) pages[m[1]] = text;
  }
  return pages;
};

/* ---------- 登录 ---------- */

// Cookie 值 = HMAC(密码) 的前 16 字节 hex；密码本身是 Worker secret，不进任何明文。改密码 = 重上 secret，所有已登录设备全部失效。
async function boardCookieToken(secret) {
  const data = new TextEncoder().encode(`agent-metro-board:${secret}`);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('agent-metro-board-v1'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
  return Array.from(sig.slice(0, 16)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 常数时间比较：不给攻击者「第一位已经对了」这类提示。
async function passwordMatch(given, secret) {
  const a = new TextEncoder().encode(String(given || ''));
  const b = new TextEncoder().encode(String(secret || ''));
  const h1 = new Uint8Array(await crypto.subtle.digest('SHA-256', a));
  const h2 = new Uint8Array(await crypto.subtle.digest('SHA-256', b));
  let diff = 0;
  for (let i = 0; i < h1.length; i++) diff |= h1[i] ^ h2[i];
  return diff === 0;
}

function cookieOf(request) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq) === COOKIE_NAME) return part.slice(eq + 1).trim();
  }
  return '';
}

async function authed(request, env) {
  if (!env.BOARD_PASSWORD) return false;
  return cookieOf(request) === await boardCookieToken(env.BOARD_PASSWORD);
}

const setCookieHeader = (value) =>
  `${COOKIE_NAME}=${value}; HttpOnly; Path=/; Max-Age=${COOKIE_MAX_AGE}; Secure; SameSite=Lax`;

// 跨站防护：写请求必须带自定义头；自定义头会让浏览器的跨站脚本在预检阶段就被挡掉。
// 命令行（cloud-sync / curl）没有 Origin 头，放行——身份在 Cookie 里，命令行要自己登录拿 Cookie。
function guardHeaders(request) {
  if (request.headers.get('X-Board-Token') !== CSRF_TOKEN) return false;
  const origin = request.headers.get('Origin');
  return !origin || origin === new URL(request.url).origin;
}

/* ---------- 页面 ---------- */

function loginPage() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>到站 · 登录</title>
<style>
  :root { color-scheme: light dark; --page:#f2f3f5; --surface:#fff; --text:#111318; --muted:#8b8f97; --accent:#2a78d6; --border:rgba(17,19,24,.1); }
  @media (prefers-color-scheme: dark) { :root { --page:#0e0f11; --surface:#1b1c1f; --text:#f3f4f6; --muted:#868a92; --accent:#3987e5; --border:rgba(255,255,255,.1); } }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--page); color:var(--text);
         font:14px/1.6 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif; -webkit-font-smoothing:antialiased; }
  .card { width:min(360px, calc(100% - 32px)); background:var(--surface); border:1px solid var(--border);
          border-radius:16px; padding:26px 24px 22px; box-shadow:0 8px 24px rgba(0,0,0,.07); }
  .logo { display:flex; align-items:center; gap:10px; margin-bottom:4px; }
  .logo svg { width:30px; height:30px; }
  h1 { font-size:20px; margin:0; }
  p { margin:6px 0 18px; color:var(--muted); font-size:12.5px; }
  input { width:100%; font:inherit; padding:10px 12px; border-radius:10px; border:1px solid var(--border);
          background:var(--page); color:var(--text); }
  input:focus { outline:2px solid var(--accent); outline-offset:2px; }
  button { width:100%; margin-top:12px; font:inherit; font-weight:600; padding:10px; border-radius:10px; border:0;
           background:var(--text); color:var(--page); cursor:pointer; }
  button:hover { opacity:.88; }
  button:disabled { opacity:.4; cursor:not-allowed; }
  .err { color:#d03b3b; font-size:12.5px; min-height:18px; margin-top:10px; }
</style>
</head>
<body>
<form class="card" id="login">
  <div class="logo" aria-hidden="true">
    <svg viewBox="0 0 28 28" fill="none"><path d="M3 14h22" stroke="currentColor" opacity=".45" stroke-width="2.4" stroke-linecap="round"/><circle cx="6.5" cy="14" r="3.4" fill="#0ca30c"/><circle cx="14" cy="14" r="3.4" fill="#d98e04"/><circle cx="21.5" cy="14" r="3.4" fill="#2a78d6"/></svg>
    <h1>到站 · 线路图</h1>
  </div>
  <p>这份台账在 Cloudflare 上，多台设备打开同一个网址。先输入看板密码。</p>
  <input type="password" name="password" placeholder="看板密码" autocomplete="current-password" autofocus>
  <button type="submit">登录</button>
  <div class="err" id="err"></div>
</form>
<script>
const form = document.getElementById('login'), err = document.getElementById('err');
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = form.querySelector('button'); const input = form.password;
  btn.disabled = true; btn.textContent = '登录中…';
  try {
    const r = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Board-Token': 'cloud' },
      body: JSON.stringify({ password: input.value }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.ok) { location.reload(); return; }
    err.textContent = j.error || ('登录失败（' + r.status + '）');
    btn.disabled = false; btn.textContent = '登录'; input.select();
  } catch (ex) {
    err.textContent = '网络不通：稍后再试';
    btn.disabled = false; btn.textContent = '登录';
  }
});
</script>
</body>
</html>`;
}

// 没设密码时给部署者看的提示页（fail closed：知道网址也看不了台账）。
function secretMissingPage() {
  const text = '这份云端看板还没有设密码。\n\n在项目目录跑一次：\n\n  npx wrangler secret put BOARD_PASSWORD\n\n设好后刷新这个页面。';
  return '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>到站</title><pre style="font:14px/1.7 system-ui;padding:24px;white-space:pre-wrap">'
    + text.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])) + '</pre>';
}

/* ---------- Durable Object：台账的单份存储 ---------- */
// 经典写法：不 import 'cloudflare:durable-objects' 的基类，Worker 通过 fetch() 转发到这里的 /call 分发。
// 存储用 this.ctx.storage（KV 型，同一个 put 原子提交多个键）。

export class BoardDO {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    let data = null;
    try {
      const url = new URL(request.url);
      if (request.method !== 'POST' || url.pathname !== '/call') return new Response('DO 只收 POST /call', { status: 404 });
      const { action, payload } = await request.json();
      if (action === 'snapshot') data = { ...(await this.snapshot()) };
      else if (action === 'revisions') data = { revisions: await this.revisionList(Number((payload || {}).limit) || 10) };
      else if (action === 'get-file') data = { value: await this.getFile(String((payload || {}).name || '')) };
      else if (action === 'run-op') data = await this.runOp(String((payload || {}).op || ''), (payload || {}).args || {});
      else if (action === 'run-pin') data = await this.runPin(payload || {});
      else if (action === 'put-file') data = await this.putFile(String((payload || {}).name || ''), (payload || {}).text, (payload || {}).baseVersion);
      else return new Response(JSON.stringify({ error: `不认识 DO 动作「${action}」` }), { status: 404 });
      return new Response(JSON.stringify({ ok: true, data }), { headers: { 'Content-Type': 'application/json' } });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e && e.message) || 'DO 出错', conflict: !!(e && e.conflict) }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
  }

  // 首次访问且存储为空 → 把打包进 Worker 的台账快照（seed.json，由 cloud/deploy.js 从本机打包）灌进去。
  // 之后云端怎么改都不受重新部署影响：seed 只在存储为空的那一刻生效。
  async ensureInit() {
    const version = await this.ctx.storage.get('version');
    if (version !== undefined) return version;
    const files = seedJson && typeof seedJson === 'object' && seedJson.files ? seedJson.files : {};
    const put = { version: 1 };
    for (const [name, text] of Object.entries(files)) {
      if (isAllowedName(name) && typeof text === 'string') put[`file:${name}`] = text;
    }
    await this.ctx.storage.put(put);
    return 1;
  }

  // 版本号 + 文件 + 快照记录放同一个 put 提交：读者要么看全旧、要么看全新。
  async saveFiles(changedFiles, nextVersion, note) {
    const put = { version: nextVersion };
    put[`rev:${nextVersion}`] = { n: nextVersion, at: new Date().toISOString(), note: String(note || '') };
    for (const [name, text] of Object.entries(changedFiles)) put[`file:${name}`] = text;
    await this.ctx.storage.put(put);
    // 快照留最近 30 份
    if (nextVersion > REVISIONS_KEPT) {
      const stale = [];
      for (const key of (await this.ctx.storage.list({ prefix: 'rev:' })).keys()) {
        const n = Number(key.slice(4));
        if (Number.isFinite(n) && n <= nextVersion - REVISIONS_KEPT) stale.push(key);
        if (stale.length >= 32) break;
      }
      if (stale.length) await this.ctx.storage.delete(stale);
    }
  }

  async snapshot() {
    await this.ensureInit();
    const version = await this.ctx.storage.get('version');
    const files = {};
    for (const key of (await this.ctx.storage.list({ prefix: 'file:' })).keys()) {
      files[key.slice(5)] = await this.ctx.storage.get(key);
    }
    const hashes = {};
    for (const [name, text] of Object.entries(files)) hashes[name] = await hashOf(text ?? '');
    return { version, files, hashes };
  }

  async getFile(name) {
    if (!isAllowedName(name)) return null;
    await this.ensureInit();
    const value = await this.ctx.storage.get(`file:${name}`);
    return value == null ? null : value;
  }

  // 和本机 applyToDisk 同一条流水线：读齐 → core.applyToFiles 算 → 一个 put 写回。算出错时一个字节都不写。
  async runOp(op, args = {}) {
    if (typeof op !== 'string' || op.length > 60) throw new Error('不认识的操作');
    if (typeof args !== 'object' || args === null) throw new Error('参数不对');
    await this.ensureInit();
    const version = await this.ctx.storage.get('version');
    const { changed, summary } = applyToFiles(op, args, {
      todoMd: (await this.ctx.storage.get('file:TODO.md')) ?? null,
      archiveMd: (await this.ctx.storage.get('file:ARCHIVE.md')) ?? null,
      historyMd: (await this.ctx.storage.get('file:HISTORY.md')) ?? '',
    });
    if (!Object.keys(changed).length) return { summary, version };
    const next = version + 1;
    await this.saveFiles(changed, next, `${op} ${summary && summary.id ? '#' + summary.id : (summary && summary.project) || ''}`);
    return { summary, version: next };
  }

  // 置顶：只允许置顶台账里真实存在的线路 / 站点（本机 board-server 的同一条规矩），pins.json 独立成文件。
  async runPin(body) {
    const kind = String((body || {}).kind || '');
    const key = String((body || {}).key || '').slice(0, 100);
    const pinned = (body || {}).pinned === true;
    const files = (await this.snapshot()).files;
    const toStaged = togglePinText({ kind, key, pinned, pinsText: files['pins.json'] || '' });
    const data = buildDataFromParts({
      todoMd: files['TODO.md'] || '', archiveMd: files['ARCHIVE.md'] || '',
      historyMd: files['HISTORY.md'] || '', pinsText: toStaged, projectPages: pagesOf(files),
    });
    const exists = kind === 'project'
      ? data.lines.some((l) => l.name === key)
      : data.lines.some((l) => l.stations.some((s) => s.id === key));
    if (!exists) throw new Error(`找不到要置顶的${kind === 'project' ? '项目' : '站点'}「${key}」`);
    const version = await this.ctx.storage.get('version');
    if (toStaged === (files['pins.json'] || '')) return { version }; // 反复点同一个开关，值没变
    const next = version + 1;
    await this.saveFiles({ 'pins.json': toStaged }, next, `pin ${kind} ${key}`);
    return { version: next };
  }

  // cloud-sync push 的落点：单个文件、要求 baseVersion = 云端当前版本，否则 409。
  async putFile(name, text, baseVersion) {
    if (!isAllowedName(name)) throw new Error(`云端不收这个文件「${name}」`);
    if (typeof text !== 'string' || !text.length || text.length > MAX_FILE) throw new Error('内容为空或超过 1MB');
    await this.ensureInit();
    const version = await this.ctx.storage.get('version');
    const expect = Number(baseVersion);
    if (!Number.isInteger(expect) || expect !== version) {
      const e = new Error('云端已被别的设备改过（版本 ' + version + ' ≠ 你提交的 ' + baseVersion + '）：先 pull 对齐；要以本地为准，用 push --force');
      e.conflict = true;
      throw e;
    }
    const existing = await this.ctx.storage.get(`file:${name}`);
    if (existing === text) return { version, unchanged: true };
    const next = version + 1;
    await this.saveFiles({ [name]: text }, next, `push ${name}`);
    return { version: next };
  }

  async revisionList(limit = 10) {
    await this.ensureInit();
    const version = await this.ctx.storage.get('version');
    const out = [];
    for (let n = version; out.length < limit && n > Math.max(0, version - REVISIONS_KEPT - 2); n--) {
      const r = await this.ctx.storage.get(`rev:${n}`);
      if (r) out.push(r);
    }
    return out;
  }
}

/* ---------- Worker → DO ---------- */

const callDO = async (env, action, payload = {}) => {
  const stub = env.BOARD.get(env.BOARD.idFromName('board'));
  const res = await stub.fetch('https://do.internal/call', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, payload }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error) {
    const e = new Error(j.error || `DO 返回 ${res.status}`);
    e.conflict = !!j.conflict;
    throw e;
  }
  return j.data;
};

const DO = {
  snapshot: (env) => callDO(env, 'snapshot'),
  revisions: (env, limit) => callDO(env, 'revisions', { limit }).then((r) => r.revisions),
  getFile: (env, name) => callDO(env, 'get-file', { name }).then((r) => r.value),
  runOp: (env, op, args) => callDO(env, 'run-op', { op, args }),
  runPin: (env, body) => callDO(env, 'run-pin', body),
  putFile: (env, name, text, baseVersion) => callDO(env, 'put-file', { name, text, baseVersion }),
};

/* ---------- 页面渲染 ---------- */

async function boardPage(env) {
  const { files } = await DO.snapshot(env);
  const data = buildDataFromParts({
    todoMd: files['TODO.md'] || '', archiveMd: files['ARCHIVE.md'] || '',
    historyMd: files['HISTORY.md'] || '', pinsText: files['pins.json'] || '',
    projectPages: pagesOf(files),
  });
  return fillTemplate(template, data, { token: 'cloud', cloud: true });
}

/* ---------- 路由 ---------- */

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (e) {
      const status = e && e.conflict ? 409 : 400;
      return json(status, { error: (e && e.message) || '服务出错' });
    }
  },
};

async function route(request, env) {
  const url = new URL(request.url);
  const method = request.method;
  const path = url.pathname.replace(/\/+$/, '') || '/';

  // Fail closed：没设密码 → 除登录接口收到「去设密码」提示外，其他请求一律不开门。
  if (!env.BOARD_PASSWORD) {
    if (path.startsWith('/api/')) return json(503, { error: '还没设密码：在项目目录跑一次 npx wrangler secret put BOARD_PASSWORD，然后刷新' });
    return page(200, secretMissingPage());
  }

  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: { Allow: 'GET, POST, OPTIONS' } });

  // 登录 / 登出：不要求已登录，但要防跨站。
  if (method === 'POST' && path === '/api/login') {
    if (!guardHeaders(request)) return json(403, { error: '请求来源不对' });
    const b = await readJson(request);
    if (!(await passwordMatch(b.password, env.BOARD_PASSWORD))) return json(403, { error: '密码不对' });
    const token = await boardCookieToken(env.BOARD_PASSWORD);
    const { version } = await DO.snapshot(env);
    return json(200, { ok: true, version }, { 'Set-Cookie': setCookieHeader(token) });
  }
  if (method === 'POST' && path === '/api/logout') {
    return json(200, { ok: true }, { 'Set-Cookie': `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; Secure; SameSite=Lax` });
  }

  const ok = await authed(request, env);

  // 页面：没登录 → 登录页；登录了 → 板子。
  if (method === 'GET' && (path === '/' || path === '/metro.html')) {
    return page(200, ok ? await boardPage(env) : loginPage());
  }

  // 项目页：本机 board-server 同款，纯文本给。
  if (method === 'GET' && path.startsWith('/projects/') && path.endsWith('.md') && ok) {
    const name = decodeURIComponent(path.slice('/projects/'.length));
    const value = await DO.getFile(env, `projects/${name}`);
    if (value === null) return plain(404, '没有这个项目页');
    return plain(200, value);
  }

  if (path.startsWith('/api/')) {
    if (!ok) return json(401, { error: '登录过期，请刷新当前页面重新登录' });

    // 心跳 / 会话 / 刷新：只读、无副作用，不走写防护。
    if (method === 'POST' && path === '/api/ping') return json(200, { ok: true, cloud: true });
    if (method === 'POST' && path === '/api/refresh') return json(200, { ok: true, restarting: false, reloaded: false, cloud: true });
    if (method === 'GET' && path === '/api/session') {
      const snap = await DO.snapshot(env);
      return json(200, { ok: true, version: snap.version, cloud: true });
    }
    if (method === 'GET' && path === '/api/sync/state') {
      const snap = await DO.snapshot(env);
      return json(200, {
        version: snap.version, files: snap.files, hashes: snap.hashes,
        revisions: await DO.revisions(env),
      });
    }

    // 写操作：先过跨站防护再进 DO。
    const doWrite = async (fn) => {
      if (!guardHeaders(request)) return json(403, { error: '请求来源不对' });
      const b = await readJson(request);
      const result = await fn(b);
      return json(200, { ok: true, ...result });
    };

    if (method === 'POST' && path === '/api/set-status') {
      return doWrite(async (b) => {
        const r = await DO.runOp(env, 'set-status', {
          id: String(b.id || ''),
          status: String(b.status || ''),
          note: String(b.note || ''),
          accept: b.status === 'done' && b.accept === 'me' ? 'me' : '',
        });
        return { result: r.summary, version: r.version };
      });
    }
    if (method === 'POST' && path === '/api/archive-project') {
      return doWrite(async (b) => {
        const r = await DO.runOp(env, 'archive-project', {
          name: String(b.name || ''), note: String(b.note || ''), undoneAs: b.undoneAs === 'done' ? 'done' : 'dropped',
        });
        return { result: r.summary, version: r.version };
      });
    }
    if (method === 'POST' && path === '/api/restore-project') {
      return doWrite(async (b) => {
        const r = await DO.runOp(env, 'restore-project', {
          name: String(b.name || ''), note: String(b.note || ''),
        });
        return { result: r.summary, version: r.version };
      });
    }
    if (method === 'POST' && path === '/api/pin') {
      return doWrite(async (b) => {
        const r = await DO.runPin(env, { kind: b.kind, key: b.key, pinned: b.pinned === true });
        return { version: r.version };
      });
    }
    // 给 cloud-sync / 远程 CLI 的通用入口：{ op, args }，整条流水线和本机 ledger.js 同一套。
    if (method === 'POST' && path === '/api/op') {
      return doWrite(async (b) => {
        const r = await DO.runOp(env, String((b || {}).op || ''), (b || {}).args || {});
        return { summary: r.summary, version: r.version };
      });
    }
    // 单文件推：cloud-sync push 的落点。
    if (method === 'POST' && path === '/api/sync/file') {
      return doWrite(async (b) => {
        const r = await DO.putFile(env, String((b || {}).name || ''), (b || {}).text, (b || {}).baseVersion);
        return { ...r };
      });
    }
  }

  return json(404, { error: '没有这个地址' });
}