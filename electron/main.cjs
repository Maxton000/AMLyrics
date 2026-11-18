/**
 * AMLyrics for Windows — Electron 主进程。
 * 只做两件事：
 *  1) 承载 homo-lyrics-master 原封不动的 AMLL 前端界面
 *  2) 把 HarmonyOS 原生桥接替换为 Windows SMTC（本地获取歌曲信息）+ 原项目联网歌词匹配
 */
'use strict';

const { app, BrowserWindow, ipcMain, globalShortcut, Menu, screen } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// 关闭「原生窗口遮挡计算」：桌面歌词属于长期置顶/被遮挡的覆盖层，
// 该特性会让 Chromium 在窗口被判定为遮挡时降帧甚至暂停绘制（表现为背景闪烁/卡住）。
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

const {
  fetchLyric,
  setSourcePriority,
  getSourcePriority,
  ALL_SOURCES,
  SOURCE_LABELS
} = require('./lyric-provider.cjs');
const { fetchSongInfo } = require('./song-info-provider.cjs');

/** 歌词源优先级持久化文件（放在 userData，跨版本保留） */
function settingsFile() {
  try {
    return path.join(app.getPath('userData'), 'lyric-sources.json');
  } catch {
    return path.join(app.getAppPath(), 'lyric-sources.json');
  }
}

function loadSourcePriority() {
  try {
    const data = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    if (Array.isArray(data.priority)) {
      setSourcePriority(data.priority);
      log('loaded source priority: ' + getSourcePriority().join(' > '));
    }
  } catch {
    // 首次运行或无文件：使用默认优先级
  }
}

function saveSourcePriority(priority) {
  setSourcePriority(priority);
  try {
    fs.writeFileSync(settingsFile(), JSON.stringify({ priority: getSourcePriority() }, null, 2), 'utf8');
  } catch (error) {
    log('failed to save source priority: ' + error.message);
  }
}

let win = null;
let helper = null;
let helperRestartTimer = null;
let isQuitting = false;
let generation = 0;
let lastCover = '';
let latestQueue = [];
let logStream = null;
// 联网匹配到的歌曲信息（封面 + 时长兜底）
let matchedSongKey = '';
let matchedDuration = 0;
let songInfoGeneration = 0;
// 最近一次歌词请求参数（供歌词源优先级调整后重新匹配）
let lastLyricQuery = { title: '', artist: '', duration: 0 };
// 无边框窗口自定义拖拽状态（渲染层在空白处按下时启动）；
// 默认走 Windows 原生移动循环，helper 不可用时退回主进程轮询定位。
let dragState = null;
let dragBounds = null;
let dragFallbackTimer = null;
let dragWatchdog = null;
let dragSettleTimer = null;

function logFile() {
  try {
    const dir = app.getPath('userData');
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, 'amlyrics.log');
  } catch {
    return path.join(app.getAppPath(), 'amlyrics.log');
  }
}

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    if (!logStream) logStream = fs.createWriteStream(logFile(), { flags: 'a' });
    logStream.write(line);
  } catch { /* ignore */ }
  console.log('[AMLyrics] ' + message);
}

function helperExecutable() {
  const packaged = path.join(process.resourcesPath, 'smtc-helper', 'SmtcBridge.exe');
  if (fs.existsSync(packaged)) return packaged;
  return path.join(__dirname, '..', 'smtc-helper', 'publish', 'SmtcBridge.exe');
}

function sendHelper(obj) {
  if (helper && helper.stdin && helper.stdin.writable) {
    helper.stdin.write(JSON.stringify(obj) + '\n');
    return true;
  }
  log('SMTC helper not writable');
  return false;
}

function mapPlayback(current) {
  if (!current) {
    return {
      title: '', artist: '', album: '', position: 0, duration: 0,
      state: 'idle', isFavorite: false, loopMode: 0,
      coverBase64: '', syncAt: 0
    };
  }
  const status = String(current.playbackStatus || '').toLowerCase();
  let state = 'idle';
  if (status.includes('playing')) state = 'playing';
  else if (status.includes('paused')) state = 'paused';

  // 封面完全来自联网匹配；进度用系统值（helper 已做本地插值），时长在缺失时用联网匹配兜底
  const systemDuration = Math.max(0, Math.round(Number(current.durationMs) || 0));
  const duration = systemDuration > 0 ? systemDuration : matchedDuration;
  return {
    title: String(current.title || ''),
    artist: String(current.artist || ''),
    album: String(current.album || ''),
    position: Math.max(0, Math.round(Number(current.positionMs) || 0)),
    duration,
    state,
    isFavorite: false,
    loopMode: 0,
    coverBase64: lastCover,
    syncAt: Number(current.syncAt) || 0
  };
}

function mapQueue(sessions) {
  if (!Array.isArray(sessions)) return latestQueue;
  const currentId = latestPlaybackId;
  latestQueue = sessions.map((s, index) => ({
    assetId: String(s.id || index),
    title: String(s.title || '未知歌曲'),
    artist: String(s.artist || ''),
    isCurrent: s.id === currentId
  }));
  return latestQueue;
}

let latestPlaybackId = '';

function sendToRenderer(channel, payload) {
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

function songKeyOf(current) {
  if (!current) return '';
  return `${String(current.title || '')}\u0001${String(current.artist || '')}\u0001${Math.round(Number(current.durationMs) || 0)}`;
}

/** 歌曲变化后联网匹配封面与时长（仿照鸿蒙项目：系统只给播放信息，其余联网补全） */
function maybeFetchSongInfo(current) {
  if (!current) return;
  const title = String(current.title || '');
  const artist = String(current.artist || '');
  if (title.length === 0) return;
  const key = songKeyOf(current);
  if (key === matchedSongKey) return;
  matchedSongKey = key;
  const gen = ++songInfoGeneration;
  // 先清掉上一首的封面/时长，避免新歌匹配期间显示错误专辑图
  lastCover = '';
  matchedDuration = 0;
  sendToRenderer('app:coverUpdate', '');
  const duration = Math.round(Number(current.durationMs) || 0);
  log(`song changed, matching online info: title="${title}" artist="${artist}" duration=${duration}`);
  fetchSongInfo(title, artist, duration).then(info => {
    if (gen !== songInfoGeneration || !info) return;
    lastCover = info.coverBase64;
    matchedDuration = Number(info.duration) || 0;
    // 单独推封面，避免覆盖正在走的进度状态
    sendToRenderer('app:coverUpdate', lastCover);
    log(`online info applied: source=${info.source} album=${info.album} duration=${matchedDuration}`);
  }).catch(error => {
    log('song info failed: ' + error.message);
  });
}

function handleHelperMessage(message) {
  if (message.type === 'ready') {
    log('SMTC bridge ready');
    sendHelper({ cmd: 'snapshot' });
    return;
  }
  if (message.type === 'error') {
    log('SMTC bridge error: ' + message.message);
    return;
  }
  if (message.type !== 'snapshot') return;

  latestPlaybackId = message.current ? String(message.current.sourceAppId || '') : '';
  maybeFetchSongInfo(message.current);
  const playback = mapPlayback(message.current);
  sendToRenderer('app:playbackUpdate', playback);
  const queue = mapQueue(message.sessions);
  if (queue.length > 0) sendToRenderer('app:queueUpdate', queue);
}

function startHelper() {
  if (isQuitting) return;
  const exe = helperExecutable();
  if (!fs.existsSync(exe)) {
    log('SMTC helper not found: ' + exe);
    return;
  }
  log('starting SMTC helper: ' + exe);
  try {
    helper = spawn(exe, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (error) {
    log('failed to spawn SMTC helper: ' + error.message);
    return;
  }

  let buffer = '';
  helper.stdout.on('data', chunk => {
    buffer += chunk.toString('utf8');
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      try {
        handleHelperMessage(JSON.parse(line));
      } catch {
        log('malformed helper message ignored');
      }
    }
  });
  helper.stderr.on('data', chunk => log('smtc: ' + chunk.toString('utf8').trim()));
  helper.on('error', error => log('SMTC helper error: ' + error.message));
  helper.on('close', code => {
    log('SMTC helper exited with code ' + code);
    helper = null;
    if (!isQuitting) {
      clearTimeout(helperRestartTimer);
      helperRestartTimer = setTimeout(startHelper, 1500);
    }
  });
}

function toggleFullscreen() {
  if (!win || win.isDestroyed()) return;
  win.setFullScreen(!win.isFullScreen());
}

function createWindow() {
  win = new BrowserWindow({
    width: 1000,
    height: 720,
    minWidth: 480,
    minHeight: 480,
    frame: false,
    // 关掉最大化：桌面歌词不需要最大化，也避免拖动时被系统放大
    maximizable: false,
    backgroundColor: '#000000',
    // 先隐藏，首帧绘制完再显示，避免启动时先闪一块黑/白空窗
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false
    }
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    if (!win || win.isDestroyed()) return;
    win.show();
    log('window shown (ready-to-show)');
  });
  win.on('enter-full-screen', () => sendToRenderer('app:fullscreenChange', true));
  win.on('leave-full-screen', () => sendToRenderer('app:fullscreenChange', false));

  // 拖拽过程中禁止改变窗口尺寸（边缘拖拽/系统吸附），避免窗口「自己变大」
  win.on('will-resize', (event) => {
    if (dragState) event.preventDefault();
  });

  const menu = Menu.buildFromTemplate([
    { label: '切换全屏', accelerator: 'F11', click: toggleFullscreen },
    { type: 'separator' },
    { label: '退出', accelerator: 'Ctrl+Q', click: () => app.quit() }
  ]);
  win.webContents.on('context-menu', () => menu.popup({ window: win }));
}

app.whenReady().then(() => {
  loadSourcePriority();
  createWindow();

  globalShortcut.register('F11', toggleFullscreen);
  globalShortcut.register('CommandOrControl+Q', () => app.quit());

  startHelper();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  isQuitting = true;
  stopWindowDrag();
  clearTimeout(helperRestartTimer);
  if (helper) {
    try { helper.kill(); } catch { /* ignore */ }
  }
  globalShortcut.unregisterAll();
});

// ===================== Web → Native (AMLyricsNative) =====================

ipcMain.on('native:notifyReady', () => {
  log('renderer ready');
  if (helper) sendHelper({ cmd: 'snapshot' });
});

ipcMain.on('native:fetchLyric', (_event, payload) => {
  const title = String((payload && payload.title) || '');
  const artist = String((payload && payload.artist) || '');
  const duration = Number((payload && payload.duration) || 0);
  const gen = ++generation;
  lastLyricQuery = { title, artist, duration };
  log(`fetchLyric title="${title}" artist="${artist}" duration=${duration}`);
  fetchLyric(title, artist, duration, gen,
    result => {
      if (gen !== generation) return;
      log(`lyric result source=${result.source} format=${result.format}`);
      sendToRenderer('app:lyricResult', result);
    },
    message => {
      if (gen !== generation) return;
      log('lyric error: ' + message);
      sendToRenderer('app:lyricError', message);
    });
});

/** 读取歌词源优先级与全部源列表（含中文名） */
ipcMain.on('native:getLyricSources', (event) => {
  event.returnValue = {
    priority: getSourcePriority(),
    all: ALL_SOURCES,
    labels: SOURCE_LABELS
  };
});

/** 设置歌词源优先级并立即用新顺序重新匹配当前歌曲 */
ipcMain.on('native:setLyricSources', (_event, priority) => {
  saveSourcePriority(priority);
  log('source priority applied: ' + getSourcePriority().join(' > '));
  if (lastLyricQuery.title) {
    const gen = ++generation;
    const { title, artist, duration } = lastLyricQuery;
    fetchLyric(title, artist, duration, gen,
      result => {
        if (gen !== generation) return;
        log(`re-fetch lyric source=${result.source} format=${result.format}`);
        sendToRenderer('app:lyricResult', result);
      },
      message => {
        if (gen !== generation) return;
        sendToRenderer('app:lyricError', message);
      });
  }
});

ipcMain.on('native:seekTo', (_event, positionMs) => {
  sendHelper({ cmd: 'seek', positionMs: Number(positionMs) || 0 });
});

ipcMain.on('native:sendCommand', (_event, command) => {
  const map = {
    play: 'play',
    pause: 'pause',
    playNext: 'next',
    playPrevious: 'previous'
  };
  const mapped = map[command];
  if (mapped) {
    sendHelper({ cmd: mapped });
  } else {
    log('command ignored: ' + command);
  }
});

ipcMain.on('native:fetchQueue', () => {
  sendToRenderer('app:queueUpdate', latestQueue);
});

ipcMain.on('native:toggleFullscreen', toggleFullscreen);

ipcMain.on('native:close', () => {
  log('close requested from renderer');
  app.quit();
});

ipcMain.on('native:minimize', () => {
  if (win && !win.isDestroyed()) win.minimize();
});

/** 无边框窗口拖拽：渲染层在空白处按下时启动，主进程按鼠标位置移动窗口。
 *  修复要点：
 *   - 用 setBounds 带上「按下时的原始宽高」，即使被系统吸附 / 跨 DPI 也不会让窗口自己变大；
 *   - 拖拽期间用 will-resize 拦掉尺寸变化；
 *   - 约 60fps（16ms）更新，比 8ms 少一半合成次数，明显减轻移动时的背景闪烁；
 *   - 位置没变时不调用，避免无意义的窗口移动。 */
function stopWindowDrag() {
  if (dragFallbackTimer !== null) {
    clearInterval(dragFallbackTimer);
    dragFallbackTimer = null;
  }
  dragState = null;
}

/** 拖拽结束后把尺寸还原（双保险：系统吸附、跨 DPI 显示器都会让窗口变大） */
function restoreDragSize() {
  const before = dragBounds;
  dragBounds = null;
  if (!before || !win || win.isDestroyed()) return;
  const now = win.getBounds();
  if (now.width !== before.width || now.height !== before.height) {
    log(`restore window size ${now.width}x${now.height} -> ${before.width}x${before.height}`);
    win.setBounds({ x: now.x, y: now.y, width: before.width, height: before.height }, false);
  }
}

ipcMain.on('native:dragStart', () => {
  if (!win || win.isDestroyed() || win.isFullScreen() || dragState) return;
  const bounds = win.getBounds();
  dragBounds = bounds;
  dragState = { native: false };
  const cursor = screen.getCursorScreenPoint();
  const offsetX = bounds.x - cursor.x;
  const offsetY = bounds.y - cursor.y;
  let lastX = bounds.x;
  let lastY = bounds.y;
  log(`window drag start at (${bounds.x},${bounds.y}) size ${bounds.width}x${bounds.height}`);
  dragFallbackTimer = setInterval(() => {
    if (!dragState || !win || win.isDestroyed() || !dragBounds) {
      stopWindowDrag();
      return;
    }
    const c = screen.getCursorScreenPoint();
    const x = Math.round(c.x + offsetX);
    const y = Math.round(c.y + offsetY);
    if (x === lastX && y === lastY) return;
    lastX = x;
    lastY = y;
    win.setBounds({ x, y, width: dragBounds.width, height: dragBounds.height }, false);
  }, 16);
});

ipcMain.on('native:dragMove', () => {
  // 位置由主进程定时器负责，渲染层无需逐帧上报；保留通道以兼容
});

ipcMain.on('native:dragEnd', () => {
  stopWindowDrag();
  restoreDragSize();
});

ipcMain.on('native:log', (_event, message) => {
  log('web: ' + String(message));
});

ipcMain.on('native:setVolume', (_event, volume) => log('setVolume not supported on Windows (ignored): ' + volume));
ipcMain.on('native:setLoopMode', (_event, mode) => log('setLoopMode not supported on Windows (ignored): ' + mode));
ipcMain.on('native:setStatusBarStyle', () => { /* no status bar on Windows */ });
ipcMain.on('native:share', () => log('share not supported on Windows (ignored)'));
ipcMain.on('native:openCastPicker', () => log('cast picker not supported on Windows (ignored)'));

app.on('window-all-closed', () => {
  // Windows  lyric overlay: keep running in tray-less mode is not useful here.
  app.quit();
});
