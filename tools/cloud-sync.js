'use strict';
// 跨设备同步的命令行：本机台账 ↔ 云端看板（Cloudflare Worker）。
// 云端是权威的同一份台账；每台设备跑 push / pull 把本机这份对齐过去，其他设备开 https://<云端地址>/ 就能看到。
//
// 用法（在项目根目录）：
//   node tools/cloud-sync.js login <网址> [密码]    登录一次，凭据存在 .board-auth.json（gitignore 里）
//   node tools/cloud-sync.js status                 本机和云端哪儿不一样
//   node tools/cloud-sync.js push [--force]         本机 → 云端（有别的设备先写过时会被拒；--force 以本机为准）
//   node tools/cloud-sync.js pull [--force]         云端 → 本机（本机有没推过的改动时会被拒；--force 以云端为准）
//   node tools/cloud-sync.js revisions              云端最近的世界线（谁改了什么）
//
// 同步语义（和 cloud/worker.js 头部注释同一套）：
//   - 本机记着「最后对齐的版本」（.board-sync.json）；云端版本变了 = 别的设备写过；
//   - push 先改方向：push --force = 本机覆盖云端；pull --force = 云端覆盖本机；不带 --force 的写操作宁可被拒也不静默互踩；
//   - 每次本机覆盖前，旧文件自动备份到 .backup/ledger-<时间戳>/ 里（和 ledger.js 的备份同一目录）。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = path.resolve(__dirname, '..');
const AUTH_FILE = path.join(REPO, '.board-auth.json');
const MARKER_FILE = path.join(REPO, '.board-sync.json');
const BASE_FILES = ['TODO.md', 'ARCHIVE.md', 'HISTORY.md', 'pins.json'];

/* ---------- 本机台账 ---------- */

function collectLocalFiles() {
  const files = {};
  for (const name of BASE_FILES) {
    const p = path.join(REPO, name);
    if (fs.existsSync(p)) files[name] = fs.readFileSync(p, 'utf8');
  }
  const dir = path.join(REPO, 'projects');
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.md') && !f.startsWith('.')) files[`projects/${f}`] = fs.readFileSync(path.join(dir, f), 'utf8');
    }
  }
  return files;
}

function hashOf(text) {
  return crypto.createHash('sha256').update(Buffer.from(String(text), 'utf8')).digest('hex').slice(0, 24);
}

function writeFileAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

// 本机被覆盖前，先把旧文件抄进 .backup/ledger-<时间戳>/（和 ledger.js 的备份一码事）。
function backupLocal(names) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const dest = path.join(REPO, '.backup', `ledger-${stamp}`);
  fs.mkdirSync(dest, { recursive: true });
  for (const name of names) {
    const src = path.join(REPO, ...name.split('/'));
    if (fs.existsSync(src)) {
      const target = path.join(dest, ...name.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(src, target);
    }
  }
  return dest;
}

/* ---------- 远端（云端看板） ---------- */

function readAuth() {
  try {
    const j = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    if (j && j.url && j.token) return j;
  } catch (e) { /* 没登录过 */ }
  console.log('还没登录。先跑一次：\n  node tools/cloud-sync.js login https://board.moonai.loan 你的密码');
  process.exit(1);
}

const saveAuth = (url, token) => writeFileAtomic(AUTH_FILE, JSON.stringify({ url, token }, null, 2) + '\n');

async function api(pathname, { method = 'GET', body } = {}) {
  const { url: base, token } = readAuth();
  const url = base.replace(/\/+$/, '') + pathname;
  const headers = {
    ...(body ? { 'Content-Type': 'application/json' } : {}),
    'Cookie': token ? `am_board=${token}` : '',   // 登录后 all requests 都带这份已保存凭据；不再要求调用方逐个传
    'X-Board-Token': 'cloud',
    'User-Agent': 'agent-metro-cloud-sync/1',
  };
  const send = () => fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  // 代理 / 网络偶发重置（TLS 建连被断）就重试一次，别把网络抖动当业务失败。
  let res;
  try {
    res = await send();
  } catch (e) {
    await new Promise((ok) => setTimeout(ok, 1500));
    try { res = await send(); } catch (e2) {
      const why = (e2 && e2.cause && e2.cause.code) || (e2 && e2.message) || '未知错误';
      throw new Error('连不上 ' + base + '（网络抖动已重试一次：' + why + '，稍后再试）');
    }
  }
  let data = null;
  try { data = await res.json(); } catch (e) { data = {}; }
  if (res.status === 401) throw new Error('登录过期：重新跑 node tools/cloud-sync.js login ' + base);
  if (res.status === 503 && data && data.error) throw new Error('云端还没设密码：' + data.error);
  if (!res.ok) {
    const e = new Error((data && data.error) || `云端返回 ${res.status}`);
    e.conflict = res.status === 409;
    throw e;
  }
  return data;
}

function readMarker() {
  try { return JSON.parse(fs.readFileSync(MARKER_FILE, 'utf8')).version ?? null; } catch (e) { return null; }
}
const saveMarker = (version) => writeFileAtomic(MARKER_FILE, JSON.stringify({ version, at: new Date().toISOString() }, null, 2) + '\n');

/* ---------- 命令 ---------- */

async function cmdLogin(url, password) {
  url = String(url || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(url)) throw new Error('网址要带协议，例如 https://board.moonai.loan');
  let pwd = password;
  if (pwd === undefined) {
    const readline = require('readline/promises');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.warn('(输入会回显在终端；不想回显就把密码写在参数里)');
    pwd = await rl.question('看板密码：');
    rl.close();
  }
  const res = await fetch(url + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Board-Token': 'cloud' },
    body: JSON.stringify({ password: pwd }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    if (res.status === 503) throw new Error('云端还没设密码：在项目目录跑 npx wrangler secret put BOARD_PASSWORD');
    throw new Error((data && data.error) || `登录失败（${res.status}）`);
  }
  const setCookie = res.headers.get('set-cookie') || '';
  const m = /am_board=([^;]+)/.exec(setCookie);
  if (!m) throw new Error('登录成功但没拿到 Cookie，稍后再试');
  saveAuth(url, m[1]);
  console.log(`登录成功：${url}（凭据存在 .board-auth.json，已在 .gitignore 里）`);
}

async function cmdStatus() {
  const state = await api('/api/sync/state');
  const local = collectLocalFiles();
  const names = [...new Set([...Object.keys(state.files), ...Object.keys(local)])].sort();
  const marker = readMarker();
  console.log(`云端：${readAuth().url}（版本 ${state.version}；本机最后对齐版本 ${marker ?? '—（没记过）'}）`);
  let diff = 0;
  for (const name of names) {
    const lh = name in local ? hashOf(local[name]) : null;
    const ch = state.hashes[name] || null;
    if (lh === ch) continue;
    diff++;
    const show = name.startsWith('projects/') ? name : name;
    if (lh === null) console.log(`  只在云端：${show}`);
    else if (ch === null) console.log(`  只在本机：${show}`);
    else console.log(`  两边不同：${show}`);
  }
  if (!diff) console.log('  本机和云端完全一致。');
  else if (marker !== null && state.version !== marker) console.log('云端版本和本机记录的对齐版本不一致——有设备先写过，先 pull / push 对齐后再动手。');
  const revs = state.revisions || [];
  if (revs.length) {
    console.log('云端最近操作：');
    for (const r of revs.slice(0, 6)) console.log(`  v${r.n} ${String(r.at).replace('T', ' ').slice(0, 16)}｜${r.note || '(未记)'}`);
  }
}

async function cmdPush(forced) {
  const state = await api('/api/sync/state');
  const local = collectLocalFiles();
  const names = [...new Set([...Object.keys(state.files), ...Object.keys(local)])].sort();
  // 本机有、云端内容不同（或云端没有）的才算「要推」；只云端有、本机没有的推不动也不动。
  const changed = names.filter((name) => name in local
    && hashOf(local[name]) !== (state.hashes[name] || null));
  const marker = readMarker();

  if (!changed.length) {
    console.log('本机和云端一致，没有要推的。');
    if (marker !== state.version) saveMarker(state.version);
    return;
  }
  if (marker !== state.version && !forced) {
    throw new Error(`云端已被别的设备改过（云端版本 ${state.version}，本机最后对齐 ${marker}）。\n先跑 pull 对齐一遍，或者想以本机为准（覆盖云端）就跑：node tools/cloud-sync.js push --force`);
  }
  // 顺序推：每个文件带「当前云端版本」当 baseVersion，成功后取新版本继续。中途别人写入会 409，原样缩手。
  let cur = state.version;
  let pushed = 0;
  for (const name of changed) {
    try {
      const r = await api('/api/sync/file', { method: 'POST', body: { name, text: local[name], baseVersion: cur } });
      cur = r.version;
      pushed++;
      console.log(`  已推：${name}（云端现版本 ${cur}${r.unchanged ? '，内容与之相同' : ''}）`);
    } catch (e) {
      console.log(`  推 ${name} 时被挡：${e.message}`);
      if (cur > state.version) saveMarker(cur);
      throw new Error('已经推上去的留在云端；本机重新跑一次 push 就会接着推剩下的。');
    }
  }
  saveMarker(cur);
  console.log(`完成：推了 ${pushed} 个文件，云端现版本 ${cur}。其他设备刷新 ${readAuth().url} 或跑 pull 即可看到。`);
}

async function cmdPull(forced) {
  const state = await api('/api/sync/state');
  const local = collectLocalFiles();
  const names = [...new Set([...Object.keys(state.files), ...Object.keys(local)])].sort();
  const marker = readMarker();
  // 云端有、本机内容不同（或本机没有）的才算「要拉」。
  const changed = names.filter((name) => name in state.files
    && (state.hashes[name] || null) !== (name in local ? hashOf(local[name]) : null));
  // 本机对云端「有内容上的改动」（两边都有但不一样）= 可能没推过的本地改动，覆盖前要确认。
  const localAhead = changed.filter((name) => name in local && (state.hashes[name] || null) !== null);

  if (!changed.length) {
    console.log(`本机已是云端版本 ${state.version}，没有要拉的。`);
    if (marker !== state.version) saveMarker(state.version);
    return;
  }
  if (localAhead.length && !forced) {
    let msg = `本机和云端不一样的文件：${changed.join('、')}。`;
    if (marker !== null && marker !== state.version) {
      msg += `云端也被别的设备改过（云端版本 ${state.version}，本机对齐 ${marker}）：两个方向都动过，先 push 试试（推不动的会 409 停下），或 pull --force（以云端为准，本机改动覆盖前会备份）。`;
    } else {
      msg += '先跑 push 把本地改动推上去；想直接让云端覆盖本机：pull --force（覆盖前自动备份）。';
    }
    throw new Error(msg);
  }
  const backupDir = backupLocal(changed);
  for (const name of changed) {
    const target = path.join(REPO, ...name.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    writeFileAtomic(target, state.files[name]);
    console.log(`  已拉：${name}`);
  }
  saveMarker(state.version);
  console.log(`完成：拉了 ${changed.length} 个文件（原来的备份到 ${path.relative(REPO, backupDir)}），云端版本 ${state.version}。`);
}

async function cmdRevisions() {
  const state = await api('/api/sync/state');
  console.log(`云端版本 ${state.version}，最近（新的在上）：`);
  for (const r of state.revisions || []) console.log(`  v${r.n} ${String(r.at).replace('T', ' ').slice(0, 19)}｜${r.note || '(未记)'}`);
}

/* ---------- 入口 ---------- */

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (cmd === 'login') await cmdLogin(rest[0], rest[1]);
    else if (cmd === 'status') await cmdStatus();
    else if (cmd === 'push') await cmdPush(rest.includes('--force'));
    else if (cmd === 'pull') await cmdPull(rest.includes('--force'));
    else if (cmd === 'revisions') await cmdRevisions();
    else {
      console.log('用法：\n  node tools/cloud-sync.js login <网址> [密码]   登录（凭据存 .board-auth.json）\n  node tools/cloud-sync.js status               本机 ↔ 云端 对比\n  node tools/cloud-sync.js push [--force]       推：本机 → 云端\n  node tools/cloud-sync.js pull [--force]       拉：云端 → 本机\n  node tools/cloud-sync.js revisions            云端最近操作');
      process.exit(1);
    }
  } catch (e) {
    // 不用 process.exit：退出码记在 process.exitCode 上，免得 libuv 关 stderr 时在 Windows 上崩出断言。
    console.error('失败：' + (e && e.message ? e.message : e));
    process.exitCode = 1;
  }
}

main();