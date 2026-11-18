/**
 * 桥接层。
 * - 定义与原生侧契约一致的推送/回调类型
 * - 封装 window.HomoNative（原生注入对象）调用：notifyReady / fetchLyric / log
 * - 向 window.HomoLyricApp 注册消息处理器（原生 runJavaScript 调用入口）
 *
 * 严格遵循 plan.md Contracts & Interfaces。
 */

/** 播放状态（与原生 PlaybackState 对齐） */
export type PlaybackState = 'idle' | 'playing' | 'paused' | 'stopped';

/** 歌词格式（与原生 LyricFormat 对齐） */
export type LyricFormat = 'TTML' | 'LRC' | 'QRC' | 'YRC';

/** 歌词来源（与原生 LyricSource 对齐） */
export type LyricSource = 'amll_ttml' | 'lrclib' | 'qq_music' | 'ncm';

/** 当前播放信息（与原生 NowPlayingInfo 对齐） */
export interface NowPlayingInfo {
  title: string;
  artist: string;
  album: string;
  position: number;
  duration: number;
  state: PlaybackState;
  isFavorite: boolean;
  loopMode: number;
  coverBase64: string;
  syncAt: number;
}

/** 歌词获取结果（与原生 LyricFetchResult 对齐） */
export interface LyricFetchResult {
  rawText: string;
  format: LyricFormat;
  source: LyricSource;
}

/** 播放列表单曲（原生 AVSession 队列） */
export interface QueueItem {
  assetId: string;
  title: string;
  artist: string;
  isCurrent: boolean;
}

/** 原生注入对象（window.HomoNative） */
export interface HomoNative {
  notifyReady(): void;
  fetchLyric(title: string, artist: string, duration: number): void;
  seekTo(positionMs: number): void;
  sendCommand(command: string): void;
  setVolume(volume: number): void;
  setLoopMode(mode: number): void;
  setStatusBarStyle(darkText: boolean): void;
  fetchQueue(): void;
  share(): void;
  openCastPicker(): void;
  /** 切换全屏（Windows Electron 端新增） */
  toggleFullscreen(): void;
  /** 关闭窗口（Windows Electron 端新增） */
  close(): void;
  /** 最小化窗口（Windows Electron 端新增） */
  minimize(): void;
  /** 开始拖动窗口（Windows Electron 端新增，无边框窗口自定义拖拽） */
  dragStart(pointerId?: number): void;
  /** 结束拖动窗口 */
  dragEnd(): void;
  /** 读取歌词源优先级配置 */
  getLyricSources(): LyricSourcesConfig;
  /** 设置歌词源优先级（高→低） */
  setLyricSources(priority: string[]): void;
  log(message: string): void;
}

/** 应用侧消息处理器（原生 → Web） */
export interface HomoLyricAppHandlers {
  onPlaybackUpdate(playback: NowPlayingInfo): void;
  onLyricResult(result: LyricFetchResult): void;
  onLyricError(message: string): void;
  onCoverUpdate(coverBase64: string): void;
  onLowFreqUpdate(volume: number): void;
  onVolumeUpdate(volume: number, max: number): void;
  onQueueUpdate(items: QueueItem[]): void;
}

interface WindowWithBridge {
  HomoNative?: HomoNative;
  HomoLyricApp?: HomoLyricAppHandlers;
}

function nativeBridge(): HomoNative | undefined {
  const w = window as unknown as WindowWithBridge;
  return w.HomoNative;
}

/** 通知原生：Web 与 React 组件挂载完成 */
export function nativeNotifyReady(): void {
  try {
    nativeBridge()?.notifyReady();
  } catch {
    // 原生侧尚未注入（开发调试环境）时静默
  }
}

/** 请求原生按降级链获取歌词（duration 为系统播放总时长毫秒，用于歌名+时长双重匹配） */
export function nativeFetchLyric(title: string, artist: string, duration: number): void {
  try {
    nativeBridge()?.fetchLyric(title, artist, duration);
  } catch {
    // ignore
  }
}

/** 请求原生向播放器发送跳转进度命令（点击歌词行时调用） */
export function nativeSeekTo(positionMs: number): void {
  try {
    nativeBridge()?.seekTo(positionMs);
  } catch {
    // ignore
  }
}

/** 请求原生发送播放控制命令（play/pause/playPrevious/playNext/toggleFavorite） */
export function nativeSendCommand(command: string): void {
  try {
    nativeBridge()?.sendCommand(command);
  } catch {
    // ignore
  }
}

/** 请求原生设置媒体音量（0-15） */
export function nativeSetVolume(volume: number): void {
  try {
    nativeBridge()?.setVolume(volume);
  } catch {
    // ignore
  }
}

/** 请求原生设置播放顺序/循环模式（0 顺序 / 1 单曲 / 2 列表 / 3 随机） */
export function nativeSetLoopMode(mode: number): void {
  try {
    nativeBridge()?.setLoopMode(mode);
  } catch {
    // ignore
  }
}

/** 请求原生设置状态栏文字颜色（darkText=true 表示顶部背景浅、用深色文字；false 用白色文字） */
export function nativeSetStatusBarStyle(darkText: boolean): void {
  try {
    nativeBridge()?.setStatusBarStyle(darkText);
  } catch {
    // ignore
  }
}

/** 请求原生获取当前播放队列 */
export function nativeFetchQueue(): void {
  try {
    nativeBridge()?.fetchQueue();
  } catch {
    // ignore
  }
}

/** 请求原生打开系统分享页面 */
export function nativeShare(): void {
  try {
    nativeBridge()?.share();
  } catch {
    // ignore
  }
}

/** 请求原生打开系统级音频输出设备选择面板 */
export function nativeOpenCastPicker(): void {
  try {
    nativeBridge()?.openCastPicker();
  } catch {
    // ignore
  }
}

/** 请求原生切换全屏显示 */
export function nativeToggleFullscreen(): void {
  try {
    nativeBridge()?.toggleFullscreen();
  } catch {
    // ignore
  }
}

/** 歌词源配置（优先级 + 全部源 + 中文名） */
export interface LyricSourcesConfig {
  priority: string[];
  all: string[];
  labels: Record<string, string>;
}

/** 读取歌词源配置 */
export function nativeGetLyricSources(): LyricSourcesConfig | undefined {
  try {
    return nativeBridge()?.getLyricSources();
  } catch {
    return undefined;
  }
}

/** 设置歌词源优先级 */
export function nativeSetLyricSources(priority: string[]): void {
  try {
    nativeBridge()?.setLyricSources(priority);
  } catch {
    // ignore
  }
}

/** 请求原生关闭窗口 */
export function nativeClose(): void {
  try {
    nativeBridge()?.close();
  } catch {
    // ignore
  }
}

/** 请求原生最小化窗口 */
export function nativeMinimize(): void {
  try {
    nativeBridge()?.minimize();
  } catch {
    // ignore
  }
}

/** 开始拖动窗口（在非交互空白区域按下时调用） */
export function nativeDragStart(pointerId?: number): void {
  try {
    nativeBridge()?.dragStart(pointerId);
  } catch {
    // ignore
  }
}

/** 结束拖动窗口 */
export function nativeDragEnd(): void {
  try {
    nativeBridge()?.dragEnd();
  } catch {
    // ignore
  }
}

/** 调试日志透传 */
export function nativeLog(message: string): void {
  try {
    nativeBridge()?.log(message);
  } catch {
    // ignore
  }
}

/** 注册消息处理器到 window.HomoLyricApp */
export function registerAppHandlers(handlers: HomoLyricAppHandlers): void {
  const app: HomoLyricAppHandlers = {
    onPlaybackUpdate: (playback: NowPlayingInfo): void => handlers.onPlaybackUpdate(playback),
    onLyricResult: (result: LyricFetchResult): void => handlers.onLyricResult(result),
    onLyricError: (message: string): void => handlers.onLyricError(message),
    onCoverUpdate: (coverBase64: string): void => handlers.onCoverUpdate(coverBase64),
    onLowFreqUpdate: (volume: number): void => handlers.onLowFreqUpdate(volume),
    onVolumeUpdate: (volume: number, max: number): void => handlers.onVolumeUpdate(volume, max),
    onQueueUpdate: (items: QueueItem[]): void => handlers.onQueueUpdate(items),
  };
  const w = window as unknown as WindowWithBridge;
  w.HomoLyricApp = app;
  nativeLog('[HomoLyrics] HomoLyricApp handlers registered');
}
