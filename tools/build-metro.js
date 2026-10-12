'use strict';
// 本机壳：从磁盘读台账文本 → 调 build-metro-core.js 的纯逻辑画线路图。
// 真正的建图 / 装模板逻辑在 build-metro-core.js；cloud/worker.js（云端看板）复用同一个 core，
// 不经过本文件。台账只读不写，页面里不保存任何第二份数据。
//   node tools/build-metro.js          生成静态的 metro.html（只读，可直接双击打开）
//   tools/board-server.js 复用这里的 buildData / renderHtml，提供可操作的版本。

const fs = require('fs');
const path = require('path');
const core = require('./build-metro-core.js');

const DEFAULT_ROOT = path.resolve(__dirname, '..');
const TEMPLATE = path.join(__dirname, 'metro-template.html');

function readIfExists(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

// buildDataFromParts 要的台账文本，从本机这份盘上收齐：三个 markdown + pins.json + projects/*.md
function gatherParts(root = DEFAULT_ROOT) {
  const dir = path.join(root, 'projects');
  const projectPages = {};
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.md')) projectPages[f.slice(0, -3)] = fs.readFileSync(path.join(dir, f), 'utf8');
    }
  }
  return {
    todoMd: readIfExists(path.join(root, 'TODO.md')),
    archiveMd: readIfExists(path.join(root, 'ARCHIVE.md')),
    historyMd: readIfExists(path.join(root, 'HISTORY.md')),
    pinsText: readIfExists(path.join(root, 'pins.json')),
    projectPages,
  };
}

function buildData(root = DEFAULT_ROOT) {
  return core.buildDataFromParts(gatherParts(root));
}

// server = null → 静态只读页；server = { token, ... } → 由本地服务提供，可以改台账。
function renderHtml(data, server = null) {
  return core.fillTemplate(fs.readFileSync(TEMPLATE, 'utf8'), data, server);
}

function writeStatic(root = DEFAULT_ROOT) {
  const data = core.buildDataFromParts(gatherParts(root));
  fs.writeFileSync(path.join(root, 'metro.html'), core.fillTemplate(fs.readFileSync(TEMPLATE, 'utf8'), data, null), 'utf8');
  return data;
}

module.exports = { buildData, renderHtml, writeStatic, gatherParts };

if (require.main === module) {
  const data = writeStatic();
  const sum = (k) => data.lines.reduce((n, l) => n + l[k], 0);
  console.log(`metro.html 已生成：${data.lines.length} 条线路，${sum('total')} 站，已到站 ${sum('done')}，停运 ${sum('dropped')}，其余 ${sum('total') - sum('done') - sum('dropped')}`);
}