'use strict';
// 部署云端看板：本机台账 → seed.json → wrangler deploy → board.moonai.loan。
// 用法（在项目根目录）：
//   node cloud/deploy.js                    部署（首次会打 seed）
//   node cloud/deploy.js --password xxx     顺便把看板密码上到 Cloudflare secret（或直接 npx wrangler secret put BOARD_PASSWORD）
// 逻辑：
//   1) 读本机台账（TODO/ARCHIVE/HISTORY/pins.json + projects/*.md）写 cloud/seed.json（seed 只在云端存储为空那一刻生效）；
//   2) npx wrangler secret put（跳过已设的）
//   3) npx wrangler deploy --config cloud/wrangler.jsonc

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const CONFIG = path.join(__dirname, 'wrangler.jsonc');
const SEED_FILE = path.join(__dirname, 'seed.json');

const readIfExists = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');

// 和 tools/build-metro.js gatherParts 收同一批文件：台账本体 + 项目页。
function buildSeed() {
  const dir = path.join(REPO, 'projects');
  const files = {
    'TODO.md': readIfExists(path.join(REPO, 'TODO.md')),
    'ARCHIVE.md': readIfExists(path.join(REPO, 'ARCHIVE.md')),
    'HISTORY.md': readIfExists(path.join(REPO, 'HISTORY.md')),
    'pins.json': readIfExists(path.join(REPO, 'pins.json')),
  };
  if (!files['TODO.md']) throw new Error('本机没有 TODO.md，没法打包 seed');
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.md')) files[`projects/${f}`] = fs.readFileSync(path.join(dir, f), 'utf8');
    }
  }
  return { generatedAt: new Date().toISOString(), files };
}

function wrangler(args, options = {}) {
  const capture = !!options.capture;
  // 带 input（比如 secret put 的密码）必须走 pipe 才能灌进去；capture 的（secret list 等要读输出）也走 pipe；默认继承终端。
  const stdio = options.stdio || (options.input !== undefined || capture ? 'pipe' : 'inherit');
  const opts = { cwd: REPO, encoding: 'utf8', shell: process.platform === 'win32', stdio, ...options };
  delete opts.capture;
  const cmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const argv = ['wrangler', ...args];
  console.log(`> ${cmd} ${argv.join(' ')}`);
  return execFileSync(cmd, argv, opts);
}

function main() {
  const args = process.argv.slice(2);
  const passwordArg = (() => {
    const i = args.indexOf('--password');
    return i >= 0 ? args[i + 1] : undefined;
  })();

  // 1) seed：云端第一次被访问时灌这份台账（之后云端是权威，重新部署不会覆盖）
  const seed = buildSeed();
  fs.writeFileSync(SEED_FILE, JSON.stringify(seed, null, 2) + '\n', 'utf8');
  console.log(`seed.json 已打包：${Object.keys(seed.files).length} 个文件（云端存储为空时才会用它初始化）\n`);

  // 2) 密码（--password 给了就顺手上 secret；没给也不拦，只提醒）
  if (passwordArg) {
    try {
      wrangler(['secret', 'put', 'BOARD_PASSWORD', '--config', 'cloud/wrangler.jsonc'], { input: passwordArg + '\n' });
      console.log('BOARD_PASSWORD 已设置/更新。\n');
    } catch (e) {
      console.error('设密码失败：' + (e.stderr || e.message) + '\n（可以稍后自己跑：npx wrangler secret put BOARD_PASSWORD）\n');
    }
  } else {
    try {
      const list = String(wrangler(['secret', 'list', '--config', 'cloud/wrangler.jsonc'], { capture: true }));
      let names = [];
      try { names = JSON.parse(list).map((s) => s.name); } catch (e) { names = list.match(/"name"\s*:\s*"([^"]+)"/g) || []; }
      if (!names.some((n) => n.includes('BOARD_PASSWORD'))) {
        console.log('注意：还没设 BOARD_PASSWORD，云端会一直显示「去设密码」。设一次：\n  npx wrangler secret put BOARD_PASSWORD\n');
      }
    } catch (e) { /* 没登录的话 deploy 那步会再报，这里不拦 */ }
  }

  // 3) 部署
  try {
    wrangler(['deploy', '--config', 'cloud/wrangler.jsonc']);
    console.log('\n部署完成。打开 https://board.moonai.loan/ 看一眼；换设备同步：node tools/cloud-sync.js login https://board.moonai.loan');
  } catch (e) {
    console.error('部署失败：' + (e.status ? `退出码 ${e.status}` : e.message));
    console.error('（常见原因：没登录 → npx wrangler login；zone 不在这个账号 → 改 cloud/wrangler.jsonc 里的 account_id）');
    process.exit(1);
  }
}

main();