#!/usr/bin/env node
/**
 * shot.mjs —— 运动打卡周报自动出图（零依赖 · 复用本机 Chrome）
 *
 * 用法
 *   node <skill目录>/scripts/shot.mjs <工作区>/reports/2026-issue05.html
 *
 * 默认行为
 *   只截周报卡片 .report · 视口 480（卡片宽 456）· dsf 2 → 宽 912（与页面「保存图片」同裁切）
 *   截图前临时隐藏固定按钮 #saveImageBtn，并阻断 html2canvas CDN
 *   输出与输入 HTML 同目录的 <文件名>.auto.png，不覆盖手动保存的 PNG
 *
 * 重要
 *   只影响无头浏览器里的这一张截图，不改 HTML、不删按钮：
 *   用浏览器打开 reports/*.html，保存按钮仍然在。
 *   个人战报保持原有手动保存流程，不在此脚本范围内。
 *
 * 常用覆盖
 *   -o <路径.png> / -s <css> / --full-page / --width / --dsf / --hide / --block / --json
 *   --no-default-hide   连截图里的 #saveImageBtn 也保留
 *   其余: --hide-mode / --wait-selector / --timeout / --retries / --quiet /
 *         --no-default-block / --chrome / --no-sandbox / --keep-temp / --verbose
 *
 * 退出码
 *   0 成功 / 1 参数或输入错误 / 2 渲染失败（重试耗尽）
 *
 * 受限环境（容器 / 受管 IDE）里 Chrome 可能因 renderer 沙箱无法建立而直接退出，
 * 此时会自动加 --no-sandbox 再试一次（不占用 --retries 次数）。
 *
 * 依赖
 *   Node >= 18；系统 Chrome / Edge / Chromium / Brave
 *   不下载浏览器、不装 npm 包；引擎与 html2png/shot-template.mjs 同源。
 **/
'use strict';

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const DEFAULTS = {
  selector: '.report',
  width: 480,
  height: 900,
  dsf: 2,
  wait: 150,
  waitSelector: '.report',
  timeout: 30000,
  retries: 1,
  hideMode: 'visibility',
  hide: ['#saveImageBtn'],
  block: ['*cdn.jsdelivr.net*'],
  outputSuffix: '.auto',
};

// Chrome 在受限环境里的典型报错：No usable sandbox / Failed to move to new namespace
const SANDBOX_STDERR = /sandbox|namespace|setuid/i;

class UserError extends Error {}
class RenderError extends Error {}

let JSON_MODE = false;
let QUIET = false;

function logInfo(...args) {
  if (QUIET) return;
  if (JSON_MODE) console.error(...args);
  else console.log(...args);
}

function usage() {
  const text = fs.readFileSync(new URL(import.meta.url), 'utf8');
  const body = text.split('/**')[1]?.split('**/')[0] || '';
  console.log(body.replace(/^ \* ?/gm, '').trim());
}

function parseArgs(argv) {
  const args = { _: [], hide: [], block: [] };
  const map = {
    '-o': 'output', '--output': 'output',
    '-s': 'selector', '--selector': 'selector',
    '--width': 'width', '--height': 'height', '--dsf': 'dsf',
    '--wait': 'wait', '--timeout': 'timeout', '--retries': 'retries',
    '--wait-selector': 'waitSelector',
    '--hide-mode': 'hideMode',
    '--chrome': 'chrome',
  };
  const repeatable = { '--hide': 'hide', '--block': 'block' };
  const flags = {
    '--full-page': 'fullPage',
    '--no-sandbox': 'noSandbox',
    '--keep-temp': 'keepTemp',
    '--verbose': 'verbose',
    '--json': 'json',
    '--quiet': 'quiet',
    '--no-default-hide': 'noDefaultHide',
    '--no-default-block': 'noDefaultBlock',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h' || a === '-?') { args.help = true; continue; }
    if (flags[a]) { args[flags[a]] = true; continue; }
    if (repeatable[a]) {
      const v = argv[++i];
      if (v === undefined) throw new UserError(`参数 ${a} 缺少值`);
      args[repeatable[a]].push(v);
      continue;
    }
    if (map[a]) {
      const v = argv[++i];
      if (v === undefined) throw new UserError(`参数 ${a} 缺少值`);
      args[map[a]] = v;
      continue;
    }
    if (a.startsWith('-')) throw new UserError(`未知参数: ${a}（--help 查看用法）`);
    args._.push(a);
  }
  return args;
}

const toInt = (v, dflt) => {
  if (v === undefined) return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new UserError(`参数值必须是非负整数: ${v}`);
  return n;
};

function toInput(raw) {
  if (/^file:\/\//i.test(raw)) {
    const abs = fileURLToPath(raw);
    return { isUrl: false, path: abs, navUrl: pathToFileURL(abs).href };
  }
  if (/^https?:\/\//i.test(raw)) {
    return { isUrl: true, path: raw, navUrl: raw };
  }
  const abs = path.resolve(raw);
  return { isUrl: false, path: abs, navUrl: pathToFileURL(abs).href };
}

function defaultOutput(inputInfo, opts) {
  let dir = process.cwd();
  let base = 'page';
  if (inputInfo.isUrl) {
    try {
      const url = new URL(inputInfo.navUrl);
      base = path.basename(decodeURIComponent(url.pathname)) || 'page';
    } catch {
      base = 'page';
    }
  } else {
    dir = path.dirname(inputInfo.path);
    base = path.basename(inputInfo.path);
  }
  base = base.replace(/\.[^.]+$/, '');
  const suffix = opts.outputSuffix || '';
  const name = (suffix && base.endsWith(suffix) ? base : base + suffix) + '.png';
  return path.join(dir, name);
}

function isExecutableFile(file) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (process.platform !== 'win32') fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** 按 显式参数 -> 环境变量 -> 平台默认路径 顺序探测 Chrome/Chromium */
function findChrome(explicit) {
  if (explicit) {
    if (isExecutableFile(explicit)) return explicit;
    throw new UserError(`--chrome 指定的文件不存在或不可执行: ${explicit}（需可执行文件绝对路径）`);
  }
  const candidates = [];
  if (process.env.CHROME_PATH) candidates.push(process.env.CHROME_PATH);
  if (process.env.CHROME_BIN) candidates.push(process.env.CHROME_BIN);
  if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary'
    );
  } else if (process.platform === 'win32') {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const lad = process.env['LocalAppData'] || '';
    candidates.push(
      pf + '\\Google\\Chrome\\Application\\chrome.exe',
      pf86 + '\\Google\\Chrome\\Application\\chrome.exe',
      lad + '\\Google\\Chrome\\Application\\chrome.exe',
      pf + '\\Microsoft\\Edge\\Application\\msedge.exe',
      pf86 + '\\Microsoft\\Edge\\Application\\msedge.exe',
      pf + '\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      pf86 + '\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      lad + '\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'
    );
  } else {
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
      '/opt/google/chrome/chrome',
      '/usr/bin/brave-browser',
      '/usr/bin/microsoft-edge'
    );
  }
  for (const p of candidates) {
    if (!p) continue;
    if (isExecutableFile(p)) return p;
  }
  throw new UserError('找不到 Chrome/Chromium。请安装 Chrome，或用 --chrome / 环境变量 CHROME_PATH / CHROME_BIN 指定可执行文件路径');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class CdpPipe {
  constructor(writePipe, readPipe) {
    this.writePipe = writePipe;
    this.readPipe = readPipe;
    this.buf = Buffer.alloc(0);
    this.nextId = 1;
    this.pending = new Map();
    this.events = new Map();
    this.closed = false;
    readPipe.on('data', (chunk) => this.#dispatch(chunk));
    readPipe.on('close', () => this.#close(new Error('Chrome CDP 连接已关闭')));
    readPipe.on('error', (err) => this.#close(err));
    writePipe.on('error', (err) => this.#close(err));
  }

  send(method, params = {}, sessionId, timeoutMs = 30000) {
    if (this.closed) return Promise.reject(new Error('Chrome CDP 连接已关闭'));
    const id = this.nextId++;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 命令超时: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.writePipe.write(JSON.stringify(message));
        this.writePipe.write('\0');
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  onEvent(sessionId, method, handler) {
    const key = `${sessionId || ''}:${method}`;
    if (!this.events.has(key)) this.events.set(key, new Set());
    this.events.get(key).add(handler);
    return () => {
      const set = this.events.get(key);
      if (!set) return;
      set.delete(handler);
      if (!set.size) this.events.delete(key);
    };
  }

  #dispatch(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    let end;
    while ((end = this.buf.indexOf(0)) !== -1) {
      const raw = this.buf.subarray(0, end).toString('utf8');
      this.buf = this.buf.subarray(end + 1);
      let message;
      try { message = JSON.parse(raw); } catch { continue; }
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message || 'CDP 命令失败'));
        else pending.resolve(message.result);
      } else if (message.method) {
        const key = `${message.sessionId || ''}:${message.method}`;
        const handlers = this.events.get(key);
        if (!handlers) continue;
        for (const handler of handlers) {
          try { handler(message); } catch { /* 事件处理失败不阻断主流程 */ }
        }
      }
    }
  }

  #close(err) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
    this.events.clear();
  }

  close() {
    this.#close(new Error('Chrome CDP 连接已关闭'));
  }
}

async function evaluate(cdp, sessionId, expression, opts = {}) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: !!opts.awaitPromise,
  }, sessionId, opts.timeoutMs || 30000);
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text || '页面脚本执行失败';
    throw new RenderError(detail);
  }
  return result.result?.value;
}

async function waitForReady(cdp, sessionId, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = await evaluate(cdp, sessionId, '({ state: document.readyState, href: location.href })', {
      timeoutMs: Math.min(5000, timeoutMs),
    });
    // Page.navigate 返回后，页面可能还停在 about:blank；必须等目标文档而不是空白页
    if (state?.state === 'complete' && state.href !== 'about:blank') return;
    await delay(100);
  }
  throw new RenderError('页面加载超时（document.readyState 未到 complete）');
}

async function waitForSelector(cdp, sessionId, selector, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ready = await evaluate(cdp, sessionId, `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    })()`, { timeoutMs: Math.min(5000, timeoutMs) });
    if (ready) return;
    await delay(100);
  }
  throw new RenderError(`等待元素超时: ${selector}`);
}

function trackNetwork(cdp, sessionId) {
  const pending = new Set();
  let lastActivity = Date.now();
  const add = (message) => {
    const request = message.params.request;
    if (!request || request.url.startsWith('data:') || request.url.startsWith('blob:')) return;
    pending.add(message.params.requestId);
    lastActivity = Date.now();
  };
  const done = (message) => {
    pending.delete(message.params.requestId);
    lastActivity = Date.now();
  };
  cdp.onEvent(sessionId, 'Network.requestWillBeSent', add);
  cdp.onEvent(sessionId, 'Network.loadingFinished', done);
  cdp.onEvent(sessionId, 'Network.loadingFailed', done);
  return {
    async waitIdle(idleMs, timeoutMs) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (pending.size === 0 && Date.now() - lastActivity >= idleMs) return true;
        await delay(100);
      }
      return pending.size === 0;
    },
    pendingCount: () => pending.size,
  };
}

async function hideElements(cdp, sessionId, selectors, mode) {
  if (!selectors.length) return;
  const declaration = mode === 'display'
    ? 'display:none !important;'
    : 'visibility:hidden !important;pointer-events:none !important;';
  const css = selectors.map((selector) => `${selector}{${declaration}}`).join('\n');
  await evaluate(cdp, sessionId, `(() => {
    const old = document.getElementById('__shot_hide__');
    if (old) old.remove();
    const style = document.createElement('style');
    style.id = '__shot_hide__';
    style.textContent = ${JSON.stringify(css)};
    document.head.appendChild(style);
    return true;
  })()`);
  // 不用 rAF：无头窗口被当作后台标签页时可能被节流
  await delay(100);
}

async function measure(cdp, sessionId, selector) {
  if (selector) {
    const rect = await evaluate(cdp, sessionId, `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height };
    })()`);
    if (!rect) throw new RenderError(`页面上找不到元素 "${selector}"`);
    if (rect.width <= 0 || rect.height <= 0) throw new RenderError(`元素 "${selector}" 尺寸为 0`);
    return rect;
  }
  const metrics = await cdp.send('Page.getLayoutMetrics', {}, sessionId);
  const size = metrics.cssContentSize || metrics.contentSize;
  if (!size || size.width <= 0 || size.height <= 0) throw new RenderError('页面内容尺寸为 0');
  return { x: 0, y: 0, width: size.width, height: size.height };
}

function readPngSize(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(24);
    const read = fs.readSync(fd, buf, 0, 24, 0);
    if (read < 24) return null;
    if (buf.toString('latin1', 1, 4) !== 'PNG') return null;
    if (buf.toString('latin1', 12, 16) !== 'IHDR') return null;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  } finally {
    fs.closeSync(fd);
  }
}

function killTree(child) {
  if (!child || !child.pid) return;
  if (process.platform === 'win32') {
    try { spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 已退出 */ }
    return;
  }
  // detached 模式下 child 是进程组组长，父进程退出后仍可能有 Chrome 子进程残留
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 已退出 */ }
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    delay(timeoutMs),
  ]);
}

async function renderOnce(inputInfo, output, opts) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-profile-'));
  const cleanupProfile = () => {
    if (opts.keepTemp) {
      console.error(`[*] 临时 profile 保留在: ${userDataDir}`);
      return;
    }
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* Windows 可能短暂占用 */ }
  };
  const chromeArgs = [
    '--headless=new',
    '--remote-debugging-pipe',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-breakpad',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-sync',
    '--metrics-recording-only',
    '--mute-audio',
    '--hide-scrollbars',
    '--disable-dev-shm-usage',
    '--user-data-dir=' + userDataDir,
  ];
  if (opts.noSandbox) chromeArgs.push('--no-sandbox', '--disable-setuid-sandbox');
  chromeArgs.push('about:blank');

  const child = spawn(opts.chrome, chromeArgs, {
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
  });
  let spawnError = null;
  child.on('error', (err) => { spawnError = err; });
  if (!child.stdio[3] || !child.stdio[4]) {
    killTree(child);
    cleanupProfile();
    throw new RenderError(spawnError ? `Chrome 启动失败: ${spawnError.message}` : '无法建立 Chrome CDP 管道');
  }

  const stderrLines = [];
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    if (opts.verbose) process.stderr.write(text);
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      stderrLines.push(line);
      if (stderrLines.length > 60) stderrLines.shift();
    }
  });

  const cdp = new CdpPipe(child.stdio[3], child.stdio[4]);
  let sessionId;

  try {
    const created = await cdp.send('Target.createTarget', { url: 'about:blank' }, undefined, opts.timeout);
    const attached = await cdp.send('Target.attachToTarget', { targetId: created.targetId, flatten: true }, undefined, opts.timeout);
    sessionId = attached.sessionId;

    await cdp.send('Page.enable', {}, sessionId, opts.timeout);
    await cdp.send('Runtime.enable', {}, sessionId, opts.timeout);
    await cdp.send('Network.enable', {}, sessionId, opts.timeout);
    if (opts.block.length) {
      await cdp.send('Network.setBlockedURLs', { urls: opts.block }, sessionId, opts.timeout);
    }
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: opts.width,
      height: opts.height,
      deviceScaleFactor: opts.dsf,
      mobile: false,
    }, sessionId, opts.timeout);

    const network = trackNetwork(cdp, sessionId);
    const navigation = await cdp.send('Page.navigate', { url: inputInfo.navUrl }, sessionId, opts.timeout);
    if (navigation.errorText) throw new RenderError(`页面加载失败: ${navigation.errorText}`);

    await waitForReady(cdp, sessionId, opts.timeout);
    await evaluate(cdp, sessionId, 'document.fonts.ready.then(() => true)', {
      awaitPromise: true,
      timeoutMs: opts.timeout,
    });
    if (opts.waitSelector) await waitForSelector(cdp, sessionId, opts.waitSelector, opts.timeout);

    const idle = await network.waitIdle(500, Math.min(3000, opts.timeout));
    if (!idle) console.error(`[!] 网络未完全空闲（仍有 ${network.pendingCount()} 个请求），继续截图`);

    if (opts.wait > 0) await delay(opts.wait);
    await hideElements(cdp, sessionId, opts.hide, opts.hideMode);

    const area = await measure(cdp, sessionId, opts.selector);
    const maxSide = Math.max(area.width, area.height) * opts.dsf;
    if (maxSide > 16384) {
      console.error(`[!] 预计长边 ${Math.round(maxSide)}px 超过 Chrome 常用纹理上限 16384px；若截图失败，请降低 --dsf 或指定更小元素`);
    }
    fs.mkdirSync(path.dirname(output), { recursive: true });

    let data;
    try {
      const shot = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: true,
        clip: { x: area.x, y: area.y, width: area.width, height: area.height, scale: 1 },
      }, sessionId, opts.timeout);
      data = shot.data;
    } catch (err) {
      throw new RenderError(`截图失败: ${err.message}（超长图可尝试降低 --dsf 或改用切片）`);
    }

    fs.writeFileSync(output, Buffer.from(data, 'base64'));
    const stat = fs.statSync(output);
    if (!stat.size) throw new RenderError('PNG 未落盘');
    const size = readPngSize(output);
    if (!size) throw new RenderError('输出文件不是有效 PNG');
    if (stat.size < 1024) console.error('[!] PNG 小于 1 KB，请确认截图区域不是空白');

    const expectedWidth = Math.round(area.width * opts.dsf);
    const expectedHeight = Math.round(area.height * opts.dsf);
    if (Math.abs(size.width - expectedWidth) > 2 || Math.abs(size.height - expectedHeight) > 2) {
      console.error(`[!] 输出尺寸 ${size.width}x${size.height} 与预期 ${expectedWidth}x${expectedHeight} 不一致`);
    }

    return { width: size.width, height: size.height, bytes: stat.size };
  } catch (err) {
    const error = spawnError
      ? new RenderError(`Chrome 启动失败: ${spawnError.message}`)
      : err;
    if (stderrLines.length) error.chromeStderr = stderrLines.slice(-8).join('\n');
    // 未建立 CDP 会话就失败，或 stderr 明确指向沙箱：先假定外层环境拦住了 renderer 沙箱
    if (!spawnError && (!sessionId || SANDBOX_STDERR.test(error.chromeStderr || ''))) {
      error.maybeSandboxBlocked = true;
    }
    throw error;
  } finally {
    try {
      await cdp.send('Browser.close', {}, undefined, 2000);
    } catch { /* browser 可能已退出 */ }
    cdp.close();
    await waitForExit(child, 2000);
    killTree(child);
    cleanupProfile();
  }
}

function buildOptions(args) {
  const selector = args.fullPage ? null : (args.selector || DEFAULTS.selector);
  const waitSelector = args.fullPage
    ? null
    : (args.waitSelector || (args.selector ? null : DEFAULTS.waitSelector));
  const opts = {
    width: toInt(args.width, DEFAULTS.width),
    height: toInt(args.height, DEFAULTS.height),
    dsf: toInt(args.dsf, DEFAULTS.dsf),
    wait: toInt(args.wait, DEFAULTS.wait),
    timeout: toInt(args.timeout, DEFAULTS.timeout),
    retries: toInt(args.retries, DEFAULTS.retries),
    selector,
    waitSelector,
    hideMode: args.hideMode || DEFAULTS.hideMode,
    hide: [...(args.noDefaultHide ? [] : DEFAULTS.hide), ...args.hide],
    block: [...(args.noDefaultBlock ? [] : DEFAULTS.block), ...args.block],
    outputSuffix: DEFAULTS.outputSuffix || '',
    chrome: null,
    noSandbox: !!args.noSandbox,
    keepTemp: !!args.keepTemp,
    verbose: !!args.verbose,
  };
  if (opts.width < 1 || opts.height < 1) throw new UserError('--width / --height 必须 >= 1');
  if (opts.dsf < 1) throw new UserError('--dsf 必须 >= 1');
  if (opts.timeout < 1) throw new UserError('--timeout 必须 >= 1');
  if (!['visibility', 'display'].includes(opts.hideMode)) {
    throw new UserError('--hide-mode 只支持 visibility 或 display');
  }
  opts.chrome = findChrome(args.chrome);
  return opts;
}

function fail(message, code) {
  if (JSON_MODE) console.log(JSON.stringify({ ok: false, error: message, exitCode: code }));
  else console.error('[x] ' + message);
  return code;
}

async function main(argv) {
  JSON_MODE = argv.includes('--json');
  QUIET = argv.includes('--quiet');

  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    return fail(err.message, 1);
  }
  if (args.help) { usage(); return 0; }
  if (!args._.length) { usage(); return 1; }
  if (args._.length > 1) return fail('一次只处理一个输入文件', 1);

  const inputInfo = toInput(args._[0]);
  if (!inputInfo.isUrl) {
    if (!fs.existsSync(inputInfo.path)) return fail('输入文件不存在: ' + inputInfo.path, 1);
    if (!fs.statSync(inputInfo.path).isFile()) return fail('输入路径不是文件: ' + inputInfo.path, 1);
  }

  let opts;
  try {
    opts = buildOptions(args);
  } catch (err) {
    return fail(err.message, 1);
  }

  const output = path.resolve(args.output || defaultOutput(inputInfo, opts));
  logInfo(`[*] Chrome: ${opts.chrome}`);
  logInfo(`[*] 输入: ${inputInfo.path}`);
  logInfo(`[*] 目标: ${opts.selector || '整页'} · ${opts.width}x${opts.height} @${opts.dsf}x`);

  const started = Date.now();
  let lastError;
  let attempts = 0;
  let escalated = opts.noSandbox;
  let attempt = 0;
  while (attempt <= opts.retries) {
    attempts++;
    try {
      const result = await renderOnce(inputInfo, output, opts);
      const kb = (result.bytes / 1024).toFixed(1);
      if (JSON_MODE) {
        console.log(JSON.stringify({
          ok: true,
          output,
          width: result.width,
          height: result.height,
          bytes: result.bytes,
          selector: opts.selector,
          dsf: opts.dsf,
          elapsedMs: Date.now() - started,
        }));
      } else {
        console.log(`[ok] ${output} (${kb} KB, ${result.width}x${result.height})`);
      }
      return 0;
    } catch (err) {
      lastError = err;
      if (!escalated && err.maybeSandboxBlocked) {
        escalated = true;
        if (err.chromeStderr) console.error(err.chromeStderr);
        console.error('[!] Chrome 启动后立即退出，疑似外层环境限制 renderer 沙箱；改用 --no-sandbox 再试一次');
        opts = { ...opts, noSandbox: true };
        continue; // 不占用 --retries 次数
      }
      console.error(`[!] 第 ${attempts} 次尝试失败: ${err.message}`);
      if (opts.verbose && err.chromeStderr) console.error(err.chromeStderr);
      attempt++;
    }
  }
  const hint = opts.noSandbox ? '' : '；可尝试加 --no-sandbox';
  return fail(`渲染失败（已尝试 ${attempts} 次）: ${lastError.message}${hint}`, 2);
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
}).catch((err) => {
  console.error('[x] ' + err.message);
  process.exitCode = 1;
});
