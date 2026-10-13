#!/usr/bin/env node
/**
 * gen-image.mjs — generate an image via Zhipu (bigmodel) and save it locally.
 *
 * Usage:
 *   node gen-image.mjs "一只深海鲸鱼娘，动漫风格" [--model cogview-4] [--size 1024x1024] [--out DIR]
 *
 * Key resolution: process env ZHIPU_API_KEY  ->  user-level env var (setx).
 * The key is never printed.
 *
 * ⚠️ 本文件是随 dsh-canvas 分发的打包副本（默认产物目录已改成跨平台位置）。
 * Output: prints the saved file path (and the remote URL) on success,
 *         prints "ERROR: ..." and exits 1 on failure.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import os from 'node:os';

const API = 'https://open.bigmodel.cn/api/paas/v4/images/generations';
// 本副本随 dsh-canvas 分发：默认产物目录跨平台可用（DSH_IMAGE_DIR 覆盖，或用 --out 显式指定）
const DEFAULT_OUT = process.env.DSH_IMAGE_DIR || path.join(os.homedir(), '.dsh', 'plugin-data', 'dsh-canvas', 'images');

function getKey() {
  if (process.env.ZHIPU_API_KEY) return process.env.ZHIPU_API_KEY.trim();
  const r = spawnSync('powershell', ['-NoProfile', '-Command',
    '[Environment]::GetEnvironmentVariable("ZHIPU_API_KEY","User")'], { encoding: 'utf8' });
  const v = (r.stdout || '').trim();
  return v || null;
}

function parseArgs(argv) {
  const out = { prompt: [], model: 'cogview-4', size: '1024x1024', out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--model') out.model = argv[++i];
    else if (a === '--size') out.size = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else out.prompt.push(a);
  }
  out.prompt = out.prompt.join(' ').trim();
  return out;
}

function slug(s) {
  const t = s.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 30);
  return t || 'image';
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const args = parseArgs(process.argv.slice(2));
if (!args.prompt) {
  console.log('ERROR: no prompt given. Usage: node gen-image.mjs "描述" [--model cogview-4] [--size 1024x1024] [--out DIR]');
  process.exit(1);
}

const key = getKey();
if (!key) {
  console.log('ERROR: ZHIPU_API_KEY not found (process env or user-level env var).');
  process.exit(1);
}

let resp, json;
try {
  resp = await fetch(API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: args.model, prompt: args.prompt, size: args.size }),
  });
  json = await resp.json();
} catch (e) {
  console.log('ERROR: request failed - ' + e.message);
  process.exit(1);
}

if (!resp.ok) {
  console.log(`ERROR: API ${resp.status} - ` + JSON.stringify(json).slice(0, 400));
  process.exit(1);
}

const item = json?.data?.[0];
const remote = item?.url || item?.image_url;
if (!remote) {
  console.log('ERROR: no image in response - ' + JSON.stringify(json).slice(0, 400));
  process.exit(1);
}

function detectExt(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'png';
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'jpg';
  if (buf.length > 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  if (buf.subarray(0, 3).toString('ascii') === 'GIF') return 'gif';
  return 'bin';
}

let file;
try {
  fs.mkdirSync(args.out, { recursive: true });
  const bin = Buffer.from(await (await fetch(remote)).arrayBuffer());
  // Zhipu hands back JPEG bytes even when a PNG name would be assumed:
  // trust the magic bytes, never the extension we wish it were.
  file = path.join(args.out, `${stamp()}-${slug(args.prompt)}.${detectExt(bin)}`);
  fs.writeFileSync(file, bin);
} catch (e) {
  console.log('ERROR: download/save failed - ' + e.message + ' (remote: ' + remote + ')');
  process.exit(1);
}

console.log('OK: ' + file);
console.log('model: ' + args.model + '  size: ' + args.size);
console.log('remote: ' + remote);
