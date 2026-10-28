/**
 * shot.mjs CLI 测试
 *
 * 参数与退出码用例不依赖浏览器；真实出图用例复用本机 Chrome，
 * 没有浏览器时自动跳过，保证纯 Node 环境也能跑完整套件。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const testDir = dirname(fileURLToPath(import.meta.url));
const shotPath = resolve(testDir, '../scripts/shot.mjs');
const node = process.execPath;

const exec = (args, opts = {}) => spawnSync(node, [shotPath, ...args], { encoding: 'utf-8', timeout: 60000, ...opts });

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'wk-shot-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writePage(dir) {
  const input = join(dir, 'report.html');
  writeFileSync(input, `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #fff; }
  .report { width: 400px; height: 300px; background: #336699; }
</style></head><body><div class="report"></div></body></html>`, 'utf-8');
  return input;
}

/** 假 Chrome：记录每次收到的参数后按「renderer 沙箱失败」退出 */
function fakeChrome(dir) {
  const bin = join(dir, 'fake-chrome');
  writeFileSync(bin, `#!/bin/sh
echo "$@" >> "$FAKE_LOG"
echo "Failed to move to new namespace: No usable sandbox" >&2
exit 1
`, 'utf-8');
  chmodSync(bin, 0o755);
  return bin;
}

const skipWin = { skip: process.platform === 'win32' && '依赖 POSIX shell 脚本' };

test('CLI：--help 打印用法并退出 0', () => {
  const r = exec(['--help']);
  assert.equal(r.status, 0, r.error?.message || r.stderr);
  assert.match(r.stdout, /用法/);
  assert.match(r.stdout, /退出码/);
});

test('CLI：无参数打印用法并退出 1', () => {
  const r = exec([]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /用法/);
});

test('CLI：未知参数退出 1', () => {
  const r = exec(['--bogus']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /未知参数/);
});

test('CLI：输入文件不存在退出 1', (t) => {
  const dir = tempDir(t);
  const r = exec([join(dir, 'missing.html')]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /输入文件不存在/);
});

test('CLI：一次多个输入退出 1', () => {
  const r = exec(['a.html', 'b.html']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /一次只处理一个输入文件/);
});

test('CLI：--json 失败只输出一行 JSON', (t) => {
  const dir = tempDir(t);
  const r = exec([join(dir, 'missing.html'), '--json']);
  assert.equal(r.status, 1);
  const lines = r.stdout.trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 1, r.stdout);
  const info = JSON.parse(lines[0]);
  assert.equal(info.ok, false);
  assert.equal(info.exitCode, 1);
});

test('CLI：--chrome 指向不可执行文件时干净退出 1', { skip: process.platform === 'win32' && 'Windows 不做 X_OK 检查' }, (t) => {
  const dir = tempDir(t);
  const input = writePage(dir);
  const notExec = join(dir, 'not-executable');
  writeFileSync(notExec, 'not a binary', 'utf-8');
  chmodSync(notExec, 0o644);
  const r = exec([input, '--chrome', notExec, '--retries', '0']);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /不可执行/);
  assert.doesNotMatch(r.stderr, /Unhandled 'error' event/);
});

test('CLI：疑似沙箱失败时自动加 --no-sandbox 重试一次', { ...skipWin }, (t) => {
  const dir = tempDir(t);
  const input = writePage(dir);
  const bin = fakeChrome(dir);
  const log = join(dir, 'calls.log');
  const r = exec([input, '--chrome', bin, '--retries', '0'], { env: { ...process.env, FAKE_LOG: log } });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /疑似外层环境限制 renderer 沙箱/);
  assert.doesNotMatch(r.stderr, /可尝试加 --no-sandbox/);
  const calls = readFileSync(log, 'utf-8').trim().split('\n');
  assert.equal(calls.length, 2, calls.join('\n'));
  assert.doesNotMatch(calls[0], /--no-sandbox/);
  assert.match(calls[1], /--no-sandbox/);
});

test('CLI：显式 --no-sandbox 不再重复降级', { ...skipWin }, (t) => {
  const dir = tempDir(t);
  const input = writePage(dir);
  const bin = fakeChrome(dir);
  const log = join(dir, 'calls.log');
  const r = exec([input, '--chrome', bin, '--retries', '0', '--no-sandbox'], { env: { ...process.env, FAKE_LOG: log } });
  assert.equal(r.status, 2, r.stderr);
  assert.doesNotMatch(r.stderr, /疑似外层环境限制/);
  const calls = readFileSync(log, 'utf-8').trim().split('\n');
  assert.equal(calls.length, 1, calls.join('\n'));
  assert.match(calls[0], /--no-sandbox/);
});

test('出图：元素截图、默认 .auto.png、不覆盖手动 PNG', (t) => {
  const dir = tempDir(t);
  const input = writePage(dir);
  const manual = join(dir, 'report.png');
  writeFileSync(manual, 'manual-export', 'utf-8');

  const r = exec([input, '--retries', '0', '--json', '--quiet']);
  if (r.status === 1 && /找不到 Chrome/.test(r.stderr)) {
    t.skip('本机没有 Chrome/Chromium，跳过真实出图用例');
    return;
  }
  assert.equal(r.status, 0, r.error?.message || r.stderr);

  const info = JSON.parse(r.stdout.trim());
  assert.equal(info.ok, true);
  assert.equal(info.width, 800);
  assert.equal(info.height, 600);
  assert.equal(info.selector, '.report');
  assert.equal(info.dsf, 2);

  const auto = join(dir, 'report.auto.png');
  assert.ok(existsSync(auto), '应生成 report.auto.png');
  assert.equal(readFileSync(manual, 'utf-8'), 'manual-export', '不得覆盖手动保存的 PNG');

  const png = readFileSync(auto);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.readUInt32BE(16), 800);
  assert.equal(png.readUInt32BE(20), 600);
});
