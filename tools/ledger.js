'use strict';
// 台账操作库：改单个站点的状态（带备注）、归档整个项目、恢复项目。
// 纯逻辑（算出新的 TODO/ARCHIVE/HISTORY 文本）已经拆去 tools/ledger-core.js，Node 和云端的 Worker 共用；
// 本文件只管「本机这份文件系统」：读文件 → 算（core.applyToFiles）→ 备份 → 写回，外加命令行入口。
// 盘上不动文件系统的另一份实现（云端）在 cloud/worker.js，两边走同一套逻辑，行为完全一致。
//
// 命令行：
//   node tools/ledger.js set-status <T编号> <done|review|doing|todo|paused|dropped> [--me] [备注…]
//     review = 待验收：AI 能做的已做完，球在用户那边（验收 / 拍板）；用户说「完成」才到站。
//     done 默认记「自动验收」（AI 自己查过就到站）；用户亲口说「完成 T0xx」时加 --me，记「人工验收」。
//   node tools/ledger.js archive-project <项目名>
//   node tools/ledger.js restore-project <项目名>
//   node tools/ledger.js list-projects
//   node tools/ledger.js set-budget <T编号> <30m|1h|1.5h|none> [备注]   这一站最多花多久；转进行中时自动计时（到点 = 现在 + 预算）
//   node tools/ledger.js set-due <T编号> <2026-10-01|2026-10-01T15:00|15:00|+1h|none> [备注]   到点（转待验收时自动定成两天后）
//   node tools/ledger.js set-ask <T编号> <日期|日期T钟点|none> [备注]   等用户审定到哪天；过了还没回，AI 按站上写好的默认方案开工；none = 审定过了
//   node tools/ledger.js belt [--json]   传送带巡检（只读）：到点没收尾 / 审定过期 / 验收筐 / 在带上 / 排队
//   node tools/ledger.js desk-sync <导出目录> [--dry]   验收台同步：页面上点的结果记进台账，台账的待验收站补卡 / 收卡（见 ledger-core.js「验收台同步」）
//   跨设备同步：本机改完台账后跑 node tools/cloud-sync.js push，把台账推上 Cloudflare；换设备跑 pull（见 cloud/README…README.md）

const fs = require('fs');
const path = require('path');

const core = require('./ledger-core.js');
const {
  setTaskStatus, setTaskDate, archiveProject, restoreProject,
  dueMs, spanMin, beltReport, beltText, deskSync, deskText,
  listArchivedProjects, parseTaskLine, stationState, eachTask, splitLines, STATE_LABEL, ACCEPT_LABEL,
  applyToFiles, pinsFromText, togglePinText,
} = core;

const DEFAULT_ROOT = path.resolve(__dirname, '..');

/* ---------- 落盘 ---------- */

function backup(root, files) {
  const dir = path.join(root, '.backup');
  const d = new Date();
  const stamp = `${core.todayIso(d).replace(/-/g, '')}-${core.pad2(d.getHours())}${core.pad2(d.getMinutes())}${core.pad2(d.getSeconds())}`;
  let dest = path.join(dir, `ledger-${stamp}`);
  for (let n = 2; fs.existsSync(dest); n++) dest = path.join(dir, `ledger-${stamp}-${n}`);
  fs.mkdirSync(dest, { recursive: true });
  for (const f of files) if (fs.existsSync(path.join(root, f))) fs.copyFileSync(path.join(root, f), path.join(dest, f));
  const old = fs.readdirSync(dir).filter((n) => n.startsWith('ledger-')).sort();
  for (const n of old.slice(0, Math.max(0, old.length - 30))) fs.rmSync(path.join(dir, n), { recursive: true, force: true });
  return dest;
}

function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

/** 在磁盘上执行一次操作：重新读取 → 计算 → 备份 → 写回。计算出错时不会动任何文件。 */
function applyToDisk(op, args = {}, root = DEFAULT_ROOT) {
  const fileNames = ['TODO.md', 'ARCHIVE.md', 'HISTORY.md'];
  const read = (name) => {
    const p = path.join(root, name);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  };
  const { changed, summary } = applyToFiles(op, args, {
    todoMd: read('TODO.md'),
    archiveMd: read('ARCHIVE.md'),
    historyMd: read('HISTORY.md'),
  });
  const backupDir = backup(root, fileNames);
  for (const name of fileNames) {
    if (changed[name] !== undefined) writeAtomic(path.join(root, name), changed[name]);
  }
  return { ...summary, backupDir };
}

/* ---------- 置顶（pins.json） ---------- */
// 文件读写在这里，开关逻辑用 core.togglePinText（和云端共用）。

const PINS_FILE = 'pins.json';

function readPins(root = DEFAULT_ROOT) {
  try {
    return pinsFromText(fs.readFileSync(path.join(root, PINS_FILE), 'utf8'));
  } catch (e) {
    return { projects: [], tasks: [] };
  }
}

function setPin({ kind, key, pinned }, root = DEFAULT_ROOT) {
  if (kind !== 'project' && kind !== 'task') throw new Error('置顶对象只能是项目或站点');
  key = String(key || '').trim().replace(/^#/, '');
  if (!key) throw new Error('没说要置顶哪一个');
  const p = path.join(root, PINS_FILE);
  let pinsText = '';
  try { pinsText = fs.readFileSync(p, 'utf8'); } catch (e) { /* 没有 pins.json，从空白开始 */ }
  writeAtomic(p, togglePinText({ kind, key, pinned, pinsText }));
  return { kind, key, pinned: !!pinned };
}

module.exports = {
  ...core,
  readPins, setPin, applyToDisk, DEFAULT_ROOT,
};

if (require.main === module) {
  const [op, ...rest] = process.argv.slice(2);
  try {
    if (op === 'list-projects') {
      const { lines } = splitLines(fs.readFileSync(path.join(DEFAULT_ROOT, 'TODO.md'), 'utf8'));
      const counts = {};
      eachTask(lines, (t) => { counts[t.project] = (counts[t.project] || 0) + 1; });
      for (const [k, v] of Object.entries(counts)) console.log(`${k}\t${v} 条`);
    // 变更记录里标明「命令行」，好和用户自己在线路图上点的区分开。
    // 命令行到站默认算「自动验收」（AI 自己判的）；用户亲口说「完成 T0xx」时加 --me 记成「人工验收」。
    } else if (op === 'set-status' && rest.length >= 2) {
      const flags = rest.filter((a) => a === '--auto' || a === '--me');
      const words = rest.filter((a) => !flags.includes(a));
      const accept = flags.includes('--me') ? 'me' : 'auto';
      const note = `[命令行] ${words.slice(2).join(' ')}`.trim();
      console.log(JSON.stringify(applyToDisk(op, { id: words[0].replace(/^#/, ''), status: words[1], note, accept }), null, 2));
    } else if ((op === 'set-due' || op === 'set-ask' || op === 'set-budget') && rest.length >= 2) {
      const note = `[命令行] ${rest.slice(2).join(' ')}`.trim();
      console.log(JSON.stringify(applyToDisk(op, { id: rest[0].replace(/^#/, ''), value: rest[1], note }), null, 2));
    } else if ((op === 'archive-project' || op === 'restore-project') && rest.length) {
      console.log(JSON.stringify(applyToDisk(op, { name: rest.join(' ').trim(), note: '[命令行]' }), null, 2));
    } else if ((op === 'pin' || op === 'unpin') && rest.length >= 2 && ['project', 'task'].includes(rest[0])) {
      console.log(JSON.stringify(setPin({ kind: rest[0], key: rest.slice(1).join(' '), pinned: op === 'pin' }), null, 2));
    } else if (op === 'belt') {
      const r = beltReport({ todoMd: fs.readFileSync(path.join(DEFAULT_ROOT, 'TODO.md'), 'utf8') });
      console.log(rest.includes('--json') ? JSON.stringify(r, null, 2) : beltText(r));
    } else if (op === 'desk-sync' && rest.some((a) => !a.startsWith('--'))) {
      const dir = path.resolve(rest.find((a) => !a.startsWith('--')));
      const readDir = (sub) => {
        const d = path.join(dir, sub); const m = {};
        if (fs.existsSync(d)) for (const f of fs.readdirSync(d)) if (f.endsWith('.json')) m[f.slice(0, -5)] = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'));
        return m;
      };
      const vf = path.join(dir, 'versions.json');
      const args = { cards: readDir('cards'), reviews: readDir('reviews'), versions: fs.existsSync(vf) ? JSON.parse(fs.readFileSync(vf, 'utf8')) : {} };
      // --dry：只算不写台账，看看会改什么
      const out = rest.includes('--dry')
        ? deskSync({ todoMd: fs.readFileSync(path.join(DEFAULT_ROOT, 'TODO.md'), 'utf8'), archiveMd: fs.readFileSync(path.join(DEFAULT_ROOT, 'ARCHIVE.md'), 'utf8'), historyMd: fs.readFileSync(path.join(DEFAULT_ROOT, 'HISTORY.md'), 'utf8'), ...args }).summary
        : applyToDisk('desk-sync', args);
      const wf = path.join(dir, 'writes.json');
      fs.writeFileSync(wf, JSON.stringify(out.writes, null, 2) + '\n', 'utf8');
      console.log(rest.includes('--json') ? JSON.stringify(out.report, null, 2) : deskText(out, wf));
    } else if (op === 'pins') {
      console.log(JSON.stringify(readPins(), null, 2));
    } else {
      console.log('用法：\n  node tools/ledger.js set-status <T编号> <done|review|doing|todo|paused|dropped> [--me] [备注]（review = 待验收；done 默认记自动验收，用户说「完成」加 --me 记人工验收）\n  node tools/ledger.js set-budget <T编号> <30m|1h|none> [备注]（预算，开工自动计时）\n  node tools/ledger.js set-due <T编号> <2026-10-01|2026-10-01T15:00|15:00|+1h|none> [备注]（到点）\n  node tools/ledger.js set-ask <T编号> <YYYY-MM-DD|none> [备注]（审定期限）\n  node tools/ledger.js belt [--json]（传送带巡检：到点没收尾 / 审定过期 / 验收筐）\n  node tools/ledger.js desk-sync <导出目录> [--dry]（验收台同步：你点的结果进台账，待验收的站上卡）\n  node tools/ledger.js archive-project <项目名>\n  node tools/ledger.js restore-project <项目名>\n  node tools/ledger.js pin|unpin project <项目名>\n  node tools/ledger.js pin|unpin task <T编号>\n  node tools/ledger.js pins\n  node tools/ledger.js list-projects');
      process.exit(1);
    }
  } catch (e) {
    console.error('失败：' + e.message);
    process.exit(1);
  }
}