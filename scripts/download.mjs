#!/usr/bin/env node
// 把 XMU.urls() 输出的签名直链清单批量下载到本地目录。
// 签名直链不需要任何 cookie，可在浏览器之外运行。
//
// 用法:
//   node download.mjs --manifest urls.json --dir ./courseware
//   node download.mjs --dir ./courseware   (从 stdin 读清单)
//
// 清单格式: [{"name":"第2章.pptx","url":"https://c-media.xmu.edu.cn/download/file/..."}, ...]

import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const arg = (flag) => {
  const i = argv.indexOf(flag);
  return i > -1 ? argv[i + 1] : null;
};

const dir = arg('--dir') || '.';
const manifestPath = arg('--manifest');
const concurrency = Number(arg('--concurrency') || 3);

let items;
try {
  items = JSON.parse(manifestPath ? readFileSync(manifestPath, 'utf8') : readFileSync(0, 'utf8'));
} catch (e) {
  console.log('无法读取清单 JSON。用 --manifest 指定文件或用 stdin 传入。');
  process.exit(1);
}
if (typeof items === 'object' && !Array.isArray(items)) items = items.urls || items.items || [];
if (!Array.isArray(items) || !items.length) {
  console.log('清单为空，没有要下载的文件。');
  process.exit(0);
}

mkdirSync(dir, { recursive: true });

const safe = (s) => String(s).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 150);

let ok = 0, fail = 0, cursor = 0;
const worker = async () => {
  while (cursor < items.length) {
    const it = items[cursor++];
    const url = typeof it === 'string' ? it : it.url;
    if (!url) { fail++; console.log('SKIP  缺少 url: ' + JSON.stringify(it).slice(0, 120)); continue; }
    const name = safe((typeof it === 'object' && it.name) || decodeURIComponent(url.split('?')[0].split('/').pop()) || 'file');
    const out = join(dir, name);
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      writeFileSync(out, buf);
      ok++;
      console.log('OK    ' + name + '  (' + (buf.length / 1024).toFixed(0) + ' KB)');
    } catch (e) {
      fail++;
      console.log('FAIL  ' + name + '  ' + e.message);
    }
  }
};

await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
console.log('\n完成: 成功 ' + ok + ' 个, 失败 ' + fail + ' 个 -> ' + dir);
