/**
 * React 壳：组装 AMLL BackgroundRender + LyricPlayer，并驱动桥接闭环。
 *
 * - 播放进度 RAF 自驱动：保存 {position, state, syncTime}，playing 时
 *   currentTime = position + (performance.now() - syncTime)（毫秒整数），暂停冻结
 * - 切歌重置歌词并调用 window.HomoNative.fetchLyric(title, artist)
 * - onLyricResult 按 format 调 lyricParse 生成 lyricLines
 * - bottomLine 插槽显示歌名+歌手；封面变更更新 BackgroundRender album
 * - 未检测到播放 / 未找到歌词 / 加载中 占位覆盖层（AMLL 深色风格）
 * - 竖屏全屏沉浸式；横屏（宽高比 > 1）左侧封面/歌曲信息分栏
 *
 * 播放页 → 歌词页过渡（Apple Music 风格）：
 * - 统一视图（player-view）常驻，viewMode 切换仅改 CSS 布局类
 * - FLIP 动画：专辑封面（缩放+平移+回弹）、歌名/歌手、收藏/更多按钮
 *   从播放页位置过渡到歌词页顶部标题栏
 * - 时间进度条、播放按钮、音量条、底部控制按钮固定在底部不动
 * - 歌词页无触摸 4 秒后控制层自动淡出（ui-hidden），触摸后重新淡入
 */
import React, { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BackgroundRender, LyricPlayer, PixiRenderer } from '@applemusic-like-lyrics/react';
import type { LyricPlayerRef } from '@applemusic-like-lyrics/react';
import type { LyricLineMouseEvent } from '@applemusic-like-lyrics/core';
import type { LyricLine } from '@applemusic-like-lyrics/lyric';
import { parseLyric } from './lyricParse';
import type { LyricFetchResult, NowPlayingInfo, PlaybackState, QueueItem } from './bridge';
import { nativeFetchLyric, nativeLog, nativeNotifyReady, nativeSeekTo, nativeSendCommand, nativeSetStatusBarStyle, nativeClose, nativeMinimize, nativeDragStart, nativeDragEnd, nativeToggleFullscreen, nativeGetLyricSources, nativeSetLyricSources, registerAppHandlers } from './bridge';
import type { LyricSourcesConfig } from './bridge';
import '@applemusic-like-lyrics/core/style.css';
import '@fortawesome/fontawesome-free/css/fontawesome.min.css';
import '@fortawesome/fontawesome-free/css/solid.min.css';
import '@fortawesome/fontawesome-free/css/regular.min.css';
import './style.css';

/** 页面模式 */
type ViewMode = 'player' | 'lyrics';

/** 播放进度基准 */
interface PlaybackBase {
  position: number;
  state: PlaybackState;
  syncTime: number;
}

/** FLIP 动画目标矩形 */
interface FlipRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const EMPTY_PLAYBACK: NowPlayingInfo = {
  title: '',
  artist: '',
  album: '',
  position: 0,
  duration: 0,
  state: 'idle',
  isFavorite: false,
  loopMode: 0,
  coverBase64: '',
  syncAt: 0,
};

/** 歌词显示偏好 localStorage 键 */
const PREF_KEY_TRANSLATION: string = 'homolyrics.showTranslation';
const PREF_KEY_ROMAJI: string = 'homolyrics.showRomaji';
/** 时钟显示偏好（与 TabletDeskClock 音乐页一致） */
const PREF_KEY_CLOCK: string = 'homolyrics.showClock';
const PREF_KEY_CLOCK_SECONDS: string = 'homolyrics.clockSeconds';
/** 歌词字体大小档位 / 歌词时差（毫秒）——与鸿蒙端一致 */
const PREF_KEY_FONT_SCALE: string = 'homolyrics.lyricFontScale';
const PREF_KEY_OFFSET_MS: string = 'homolyrics.lyricOffsetMs';
/** 歌词字体大小可选档位（1 = 默认字号，不设置 CSS 变量保证零回归） */
const FONT_SCALE_STEPS: number[] = [0.75, 0.875, 1, 1.125, 1.25, 1.5];
/** 歌词时差调节步长与范围（毫秒） */
const OFFSET_STEP_MS: number = 500;
const OFFSET_LIMIT_MS: number = 10000;

/** 读取持久化偏好（默认 def） */
function readPreference(key: string, def: boolean): boolean {
  try {
    const v: string | null = window.localStorage.getItem(key);
    return v === null ? def : v === '1';
  } catch {
    return def;
  }
}

/** 持久化偏好 */
function persistPreference(key: string, value: boolean): void {
  try {
    window.localStorage.setItem(key, value ? '1' : '0');
  } catch {
    // 存储不可用时静默
  }
}

/** 读取持久化数值偏好（默认 def，非法值回退 def） */
function readNumericPreference(key: string, def: number): number {
  try {
    const v: string | null = window.localStorage.getItem(key);
    if (v === null) return def;
    const n: number = Number(v);
    return Number.isFinite(n) ? n : def;
  } catch {
    return def;
  }
}

/** 持久化数值偏好 */
function persistNumericPreference(key: string, value: number): void {
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // 存储不可用时静默
  }
}

/**
 * 计算封面图平均相对亮度（0-255）。
 * 用于推断顶部 safearea 背景深浅，进而决定系统状态栏文字/图标颜色。
 */
function computeCoverLuminance(dataUrl: string): Promise<number | null> {
  return new Promise((resolve): void => {
    const img = new Image();
    img.onload = (): void => {
      try {
        const size = 32;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (ctx === null) {
          resolve(null);
          return;
        }
        ctx.drawImage(img, 0, 0, size, size);
        const data: Uint8ClampedArray = ctx.getImageData(0, 0, size, size).data;
        let sum = 0;
        for (let i = 0; i < data.length; i += 4) {
          sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        }
        resolve(sum / (size * size));
      } catch {
        resolve(null);
      }
    };
    img.onerror = (): void => resolve(null);
    img.src = dataUrl;
  });
}

/** 歌词净化：开头为 作词:/作曲:/制作人: 的制作信息行直接剔除 */
const CREDIT_LINE_RE = /^(作词|作曲|制作人|编曲)\s*[:：]/;

function isCreditLine(line: LyricLine): boolean {
  const text: string = line.words.map((w): string => w.word).join('').trim();
  return CREDIT_LINE_RE.test(text);
}

/** 记录上一次渲染值 */
function usePrevious<T>(value: T): T | undefined {
  const ref = useRef<T | undefined>(undefined);
  useEffect((): void => {
    ref.current = value;
  }, [value]);
  return ref.current;
}

/** 读取元素屏幕矩形 */
function rectOf(el: HTMLElement): FlipRect {
  const r: DOMRect = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

/**
 * FLIP 过渡：将元素从 first 屏幕位置动画到 last 屏幕位置。
 * withScale 为 true 时缩放+平移（封面图片），false 时仅平移（文本/按钮）。
 *
 * 使用 Web Animations API（el.animate）：动画结束后不留任何内联样式，
 * 元素自然落回布局位置，终点与目标完全对齐、无抽搐。
 * 缓动仅用非线性 ease（无回弹过冲）。
 *
 * 封面同时补一段 border-radius 动画：由于 wrapper 带缩放，圆角会被一起放大，
 * 故起止半径按缩放比例换算（firstRadius/sx → lastRadius），使视觉圆角平滑渐变。
 */
function flipTo(
  el: HTMLElement,
  first: FlipRect,
  last: FlipRect,
  duration: number,
  easing: string,
  withScale: boolean,
  firstRadius?: number,
  lastRadius?: number
): void {
  const dx: number = first.left - last.left;
  const dy: number = first.top - last.top;
  const from: string = withScale
    ? `translate(${dx}px, ${dy}px) scale(${first.width / last.width}, ${first.height / last.height})`
    : `translate(${dx}px, ${dy}px)`;
  el.style.transformOrigin = '0 0';
  el.animate(
    [
      { transform: from },
      { transform: 'none' }
    ],
    { duration, easing, fill: 'none' }
  );
  if (withScale && firstRadius !== undefined && lastRadius !== undefined) {
    const sx: number = last.width > 0 ? first.width / last.width : 1;
    const inner = el.querySelector<HTMLElement>('.player-cover');
    if (inner !== null && sx > 0.01) {
      inner.animate(
        [
          { borderRadius: `${firstRadius / sx}px` },
          { borderRadius: `${lastRadius}px` }
        ],
        { duration: Math.round(duration * 0.85), easing, fill: 'none' }
      );
    }
  }
}

/**
 * 数字位单元格：数值变化时旧数字下沉模糊消失、新数字从上方下沉清晰进入。
 * 新数字常驻（key 变化重建，动画完整播放）；旧数字在动画期间保留，定时后卸载。
 * 统一下沉方向（9→0 同样下沉），带回弹与模糊过渡，多位数按从左到右延迟。
 */
const DigitCell: React.FC<{ value: string; delay: number }> = ({ value, delay }) => {
  const prev = usePrevious(value);
  const [oldValue, setOldValue] = useState<string | null>(null);

  useEffect(() => {
    if (prev !== undefined && prev !== value) {
      setOldValue(prev);
      const timer = setTimeout((): void => {
        setOldValue(null);
      }, 450);
      return (): void => {
        clearTimeout(timer);
      };
    }
    return;
  }, [value, prev]);

  const animStyle: React.CSSProperties = { animationDelay: `${delay}ms` };
  return (
    <span className="digit-anim">
      {oldValue !== null && (
        <span key={`old-${oldValue}`} className="digit-old" style={animStyle}>{oldValue}</span>
      )}
      <span key={`new-${value}`} className="digit-new" style={animStyle}>{value}</span>
    </span>
  );
};

/**
 * 水平滚动文本：文本超长时不省略，先停留数秒再向左滚动到末尾；
 * 两端带模糊渐变遮罩，显得更自然。
 */
const MarqueText: React.FC<{ text: string; className: string }> = ({ text, className }) => {
  const wrapRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLSpanElement>(null);
  const [overflowing, setOverflowing] = useState<boolean>(false);
  const [distance, setDistance] = useState<number>(0);

  useEffect(() => {
    const wrap = wrapRef.current;
    const inner = innerRef.current;
    if (wrap === null || inner === null) {
      return;
    }
    const check = (): void => {
      const over: boolean = inner.scrollWidth > wrap.clientWidth;
      setOverflowing(over);
      if (over) {
        setDistance(inner.scrollWidth - wrap.clientWidth);
      } else {
        setDistance(0);
      }
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(wrap);
    return (): void => {
      ro.disconnect();
    };
  }, [text]);

  return (
    <div className={`${className} marquee${overflowing ? ' overflowing' : ''}`} ref={wrapRef}>
      <span className="marquee-track" ref={innerRef}
        style={overflowing ? {
          transform: `translateX(${-distance}px)`,
          transitionDelay: '2.2s',
          transitionDuration: `${Math.max(3, distance / 40)}s`,
        } : undefined}>
        {text}
      </span>
    </div>
  );
};

/** 上一曲/下一曲图标动画句柄 */
export interface ArrowHandle {
  pulse(): void;
}

/**
 * 上一曲/下一曲图标：
 * - 按下缩小（.ctl-btn:active 对 .switch-arrow 容器做 scale 0.9）
 * - 松开 pulse()：旧箭头加速"刷地"飞出（whoosh），新箭头自后方跟上并回弹落位（follow）
 *   whoosh 用加速（ease-in），follow 用非线性 + 轻微回弹（overshoot）
 */
const NextPrevIcon = React.forwardRef<ArrowHandle, { iconClass: string; direction: 'prev' | 'next' }>(
  ({ iconClass, direction }, ref) => {
    const [runId, setRunId] = useState<number>(-1);
    const [leaving, setLeaving] = useState<boolean>(false);
    const timerRef = useRef<number>(0);

    useImperativeHandle(ref, (): ArrowHandle => ({
      pulse: (): void => {
        setLeaving(true);
        setRunId(Date.now());
        if (timerRef.current !== 0) {
          window.clearTimeout(timerRef.current);
        }
        timerRef.current = window.setTimeout((): void => {
          timerRef.current = 0;
          setLeaving(false);
        }, 560);
      }
    }), []);

    return (
      <span className={`switch-arrow ${direction}`}>
        {leaving && (
          <i key={`ghost-${runId}`} className={`${iconClass} arrow-ghost`} aria-hidden="true" />
        )}
        <i key={`main-${runId}`} className={`${iconClass} arrow-main${runId >= 0 ? ' follow' : ''}`} aria-hidden="true" />
      </span>
    );
  }
);

const App: React.FC = () => {
  const [playback, setPlayback] = useState<NowPlayingInfo>(EMPTY_PLAYBACK);
  const [lyricLines, setLyricLines] = useState<LyricLine[]>([]);
  const [hasLyric, setHasLyric] = useState<boolean>(false);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [lowFreqVolume, setLowFreqVolume] = useState<number>(0);
  const [viewMode, setViewMode] = useState<ViewMode>('player');
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [uiHidden, setUiHidden] = useState<boolean>(false);
  const [isLandscape, setIsLandscape] = useState<boolean>(() => window.innerWidth > window.innerHeight);
  const [hasTranslation, setHasTranslation] = useState<boolean>(false);
  const [hasRomaji, setHasRomaji] = useState<boolean>(false);
  const [showTranslation, setShowTranslation] = useState<boolean>(() => readPreference(PREF_KEY_TRANSLATION, true));
  const [showRomaji, setShowRomaji] = useState<boolean>(() => readPreference(PREF_KEY_ROMAJI, true));
  // 时钟：默认显示，秒开关默认关（与 TabletDeskClock 音乐页一致）
  const [showClock, setShowClock] = useState<boolean>(() => readPreference(PREF_KEY_CLOCK, true));
  const [clockSeconds, setClockSeconds] = useState<boolean>(() => readPreference(PREF_KEY_CLOCK_SECONDS, false));
  const [clockText, setClockText] = useState<string>('');
  const [clockFontSize, setClockFontSize] = useState<number>(42);
  // 背景渲染（Pixi + WebGL）体积大、初始化慢：延后到首帧之后再挂载，
  // 让窗口先黑底显示出来，避免启动时白屏/卡住几百毫秒。
  const [bgReady, setBgReady] = useState<boolean>(false);
  const [clockWidth, setClockWidth] = useState<number>(420);
  const clockRef = useRef<HTMLDivElement>(null);
  const prevIconRef = useRef<ArrowHandle | null>(null);
  const nextIconRef = useRef<ArrowHandle | null>(null);
  // 更多面板：字体大小 / 时差 / 歌词源优先级（与鸿蒙端 + 自定义歌词源一致）
  const [moreOpen, setMoreOpen] = useState<boolean>(false);
  const [fontScale, setFontScale] = useState<number>(() => {
    const v: number = readNumericPreference(PREF_KEY_FONT_SCALE, 1);
    return FONT_SCALE_STEPS.includes(v) ? v : 1;
  });
  const [lyricOffsetMs, setLyricOffsetMs] = useState<number>(() => Math.round(readNumericPreference(PREF_KEY_OFFSET_MS, 0)));
  const [sourcesConfig, setSourcesConfig] = useState<LyricSourcesConfig>({ priority: [], all: [], labels: {} });
  const [toast, setToast] = useState<string>('');
  const toastTimerRef = useRef<number>(0);
  const coverSwipeStartXRef = useRef<number | null>(null);
  const coverSwipeStartYRef = useRef<number | null>(null);

  const baseRef = useRef<PlaybackBase>({ position: 0, state: 'idle', syncTime: 0 });
  const rafRef = useRef<number>(0);
  const songKeyRef = useRef<string>('');
  const visibleRef = useRef<boolean>(document.visibilityState === 'visible');
  const rootRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const coverWrapRef = useRef<HTMLDivElement>(null);
  const metaRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const fixedRef = useRef<HTMLDivElement>(null);
  const lyricWrapRef = useRef<HTMLDivElement>(null);
  const lyricPlayerRef = useRef<LyricPlayerRef | null>(null);
  const firstRectsRef = useRef<{
    cover?: FlipRect;
    meta?: FlipRect;
    actions?: FlipRect;
    fixed?: FlipRect;
    clock?: FlipRect;
    coverRadius?: number;
  }>({});
  const prevModeRef = useRef<ViewMode>('player');
  const hideTimerRef = useRef<number>(0);
  const inLyricsRef = useRef<boolean>(false);
  const progressDraggingRef = useRef<boolean>(false);
  const windowDraggingRef = useRef<boolean>(false);
  const lyricGestureRef = useRef<{ x: number; y: number; scrolled: boolean; reveal: boolean } | null>(null);
  const isLargeLandscapeRef = useRef<boolean>(window.innerWidth >= 900 && window.innerWidth > window.innerHeight);
  const [manualMode, setManualMode] = useState<boolean>(false);
  const [freezeTime, setFreezeTime] = useState<number>(0);
  const liveTimeRef = useRef<number>(0);
  const manualTimerRef = useRef<number>(0);
  const [progressPressed, setProgressPressed] = useState<boolean>(false);
  const manualModeRef = useRef<boolean>(false);

  /** 退出手动滚动模式：恢复正常跟随。snap=true 时复位滚动并跳转到指定时间（缺省为当前播放时间）。 */
  const leaveManualMode = useCallback((snap: boolean, targetTime?: number): void => {
    if (!manualModeRef.current) {
      return;
    }
    manualModeRef.current = false;
    setManualMode(false);
    if (manualTimerRef.current !== 0) {
      window.clearTimeout(manualTimerRef.current);
      manualTimerRef.current = 0;
    }
    const player = lyricPlayerRef.current?.lyricPlayer;
    if (player !== undefined) {
      player.resetScroll();
      if (snap) {
        player.setCurrentTime(targetTime ?? liveTimeRef.current, true);
      }
    }
  }, []);

  /** 进入/刷新手动滚动模式：冻结歌词时间（不自动滚动）、关闭模糊，并重置 3s 恢复计时 */
  const enterManualMode = useCallback((): void => {
    if (!manualModeRef.current) {
      manualModeRef.current = true;
      setFreezeTime(liveTimeRef.current);
      setManualMode(true);
    }
    if (manualTimerRef.current !== 0) {
      window.clearTimeout(manualTimerRef.current);
    }
    manualTimerRef.current = window.setTimeout((): void => {
      manualTimerRef.current = 0;
      leaveManualMode(true);
    }, 3000);
  }, [leaveManualMode]);

  /** 点击歌词行：音乐进度跳转到该行，歌词视图立即对齐（AMLL isSeek 分支会复位滚动并重新布局） */
  const onLyricLineClick = useCallback((e: LyricLineMouseEvent): void => {
    if (playback.duration <= 0) {
      return;
    }
    const lineMs: number = e.line.getLine().startTime;
    const ms: number = Math.max(0, lineMs - lyricOffsetMs); // 时差：目标时间 = 行时间 - 时差
    nativeLog(`[HomoLyrics] onLyricLineClick lineIndex=${e.lineIndex} time=${ms}`);
    nativeSeekTo(ms);
    baseRef.current = { position: ms, state: playback.state, syncTime: performance.now() };
    setCurrentTime(ms);
    const player = lyricPlayerRef.current?.lyricPlayer;
    if (player !== undefined) {
      player.setCurrentTime(ms, true);
    }
    leaveManualMode(false);
  }, [playback.state, playback.duration, leaveManualMode, lyricOffsetMs]);

  const playing: boolean = playback.state === 'playing';

  /** 检测当前歌词是否含翻译/罗马音；存在则显示对应切换按钮（显示偏好持久化，不随切歌重置） */
  useEffect(() => {
    const hasTrans: boolean = lyricLines.some((l: LyricLine): boolean =>
      (l.translatedLyric ?? '').trim().length > 0);
    const hasRom: boolean = lyricLines.some((l: LyricLine): boolean =>
      (l.romanLyric ?? '').trim().length > 0);
    setHasTranslation(hasTrans);
    setHasRomaji(hasRom);
  }, [lyricLines]);

  /** RAF 自驱动播放进度 */
  const tick = useCallback((): void => {
    const base = baseRef.current;
    if (base.state === 'playing' && visibleRef.current && !progressDraggingRef.current) {
      const elapsed: number = performance.now() - base.syncTime;
      setCurrentTime(Math.floor(base.position + elapsed));
    }
    rafRef.current = window.requestAnimationFrame(tick);
  }, []);

  useEffect(() => {
    rafRef.current = window.requestAnimationFrame(tick);
    return (): void => {
      if (rafRef.current !== 0) {
        window.cancelAnimationFrame(rafRef.current);
      }
    };
  }, [tick]);

  /** 同步当前播放时间到 ref（手动滚动模式冻结需要最新值） */
  useLayoutEffect(() => {
    liveTimeRef.current = currentTime;
  }, [currentTime]);

  /** 页面不可见时暂停 RAF 计算（恢复时重置基准） */
  useEffect(() => {
    const onVisibilityChange = (): void => {
      visibleRef.current = document.visibilityState === 'visible';
      if (visibleRef.current) {
        const base = baseRef.current;
        base.syncTime = performance.now();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return (): void => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  /** 监听屏幕方向/宽度变化 */
  useEffect(() => {
    const onResize = (): void => {
      const wide: boolean = window.innerWidth >= 900;
      const largeLandscape: boolean = wide && window.innerWidth > window.innerHeight;
      isLargeLandscapeRef.current = largeLandscape;
      setIsLandscape(window.innerWidth > window.innerHeight);
      // 进入大屏横屏：控制区常驻，清掉可能存在的隐藏计时并强制显示
      if (largeLandscape) {
        if (hideTimerRef.current !== 0) {
          window.clearTimeout(hideTimerRef.current);
          hideTimerRef.current = 0;
        }
        setUiHidden(false);
      }
    };
    window.addEventListener('resize', onResize);
    return (): void => {
      window.removeEventListener('resize', onResize);
    };
  }, []);

  /** 全屏状态同步：主进程 F11 / 全屏按钮触发的 electron-fullscreen-change 事件 */
  useEffect(() => {
    const handler = (e: Event): void => {
      setIsFullscreen((e as CustomEvent<boolean>).detail === true);
    };
    window.addEventListener('homo-fullscreen-change', handler);
    return (): void => {
      window.removeEventListener('homo-fullscreen-change', handler);
    };
  }, []);

  /** Esc 退出全屏（不拦截应用内普通 Esc 交互） */
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && isFullscreen) {
        nativeToggleFullscreen();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return (): void => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [isFullscreen]);

  // ===================== 时钟（仿 TabletDeskClock 音乐页） =====================

  /** 按秒/分对齐节拍刷新时钟文本 */
  useEffect(() => {
    let timer = 0;
    const pad = (n: number): string => (n < 10 ? `0${n}` : `${n}`);
    const renderClock = (): void => {
      const d = new Date();
      let text = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
      if (clockSeconds) text += `:${pad(d.getSeconds())}`;
      setClockText(text);
    };
    const tick = (): void => {
      window.clearTimeout(timer);
      if (!showClock) return;
      renderClock();
      const step = clockSeconds ? 1000 : 60000;
      const now = Date.now();
      timer = window.setTimeout(tick, step - (now % step) + 8);
    };
    tick();
    return (): void => { window.clearTimeout(timer); };
  }, [showClock, clockSeconds]);

  /** 宽度与字号跟随封面（42px @ 460px 封面，与 TabletDeskClock 一致） */
  useEffect(() => {
    if (!showClock) return;
    const measure = (): void => {
      const cover = coverWrapRef.current;
      if (!cover) return;
      const w = cover.getBoundingClientRect().width;
      if (w > 0) {
        setClockWidth(w);
        setClockFontSize(Math.round(w * 0.0913));
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (coverWrapRef.current) observer.observe(coverWrapRef.current);
    return (): void => { observer.disconnect(); };
  }, [showClock, viewMode]);

  // ===================== 播放页 / 歌词页过渡 =====================

  /** 取消元素上仍在播放的 FLIP 动画（防止中途切换时按动画中的位置测量） */
  const cancelFlip = (el: HTMLElement | null): void => {
    if (el !== null) {
      el.getAnimations().forEach((anim: Animation): void => {
        anim.cancel();
      });
    }
  };

  /** 切换页面模式：先记录各元素的旧位置（FLIP first），再触发布局变更 */
  const changeMode = (next: ViewMode): void => {
    if (viewMode === next) {
      return;
    }
    cancelFlip(coverWrapRef.current);
    cancelFlip(metaRef.current);
    cancelFlip(actionsRef.current);
    cancelFlip(fixedRef.current);
    cancelFlip(clockRef.current);
    let coverRadius: number | undefined = undefined;
    const coverEl = coverWrapRef.current;
    if (coverEl !== null) {
      const inner = coverEl.querySelector<HTMLElement>('.player-cover');
      if (inner !== null) {
        const r: number = parseFloat(window.getComputedStyle(inner).borderRadius);
        if (Number.isFinite(r)) {
          coverRadius = r;
        }
      }
    }
    firstRectsRef.current = {
      cover: coverEl !== null ? rectOf(coverEl) : undefined,
      meta: metaRef.current !== null ? rectOf(metaRef.current) : undefined,
      actions: actionsRef.current !== null ? rectOf(actionsRef.current) : undefined,
      fixed: fixedRef.current !== null ? rectOf(fixedRef.current) : undefined,
      clock: clockRef.current !== null ? rectOf(clockRef.current) : undefined,
      coverRadius,
    };
    setViewMode(next);
  };

  /** 底部歌词按钮：播放页/歌词页双向切换 */
  const toggleLyrics = (): void => {
    changeMode(viewMode === 'lyrics' ? 'player' : 'lyrics');
  };

  /** 布局已切换后：测量新位置（FLIP last），对三个元素执行 FLIP 过渡（无回弹） */
  useLayoutEffect((): void => {
    if (prevModeRef.current === viewMode) {
      return;
    }
    const rootEl = rootRef.current;
    if (rootEl !== null) {
      const topEl = topRef.current;
      const fixedEl = fixedRef.current;
      if (topEl !== null) {
        rootEl.style.setProperty('--top-h', `${topEl.getBoundingClientRect().height}px`);
      }
      if (fixedEl !== null) {
        rootEl.style.setProperty('--fixed-h', `${fixedEl.getBoundingClientRect().height}px`);
      }
    }
    const first = firstRectsRef.current;
    const coverEl = coverWrapRef.current;
    const metaEl = metaRef.current;
    const actionsEl = actionsRef.current;
    if (coverEl !== null && first.cover !== undefined) {
      let lastRadius: number | undefined = undefined;
      const inner = coverEl.querySelector<HTMLElement>('.player-cover');
      if (inner !== null) {
        const r: number = parseFloat(window.getComputedStyle(inner).borderRadius);
        if (Number.isFinite(r)) {
          lastRadius = r;
        }
      }
      flipTo(coverEl, first.cover, rectOf(coverEl), 620, 'cubic-bezier(0.16, 1, 0.3, 1)', true,
        first.coverRadius, lastRadius);
    }
    // 时钟跟随封面：与封面同款 620ms 曲线，用文字中心点算 dx（宽度会随封面变化瞬变），
    // 只做纯 translate（尺寸由 CSS width/font-size 过渡同步插值）——与 TabletDeskClock 一致
    const clockEl = clockRef.current;
    if (clockEl !== null && first.clock !== undefined) {
      const lastRect: FlipRect = rectOf(clockEl);
      const oldCx: number = first.clock.left + first.clock.width / 2;
      const nowCx: number = lastRect.left + lastRect.width / 2;
      const dx: number = oldCx - nowCx;
      const dy: number = first.clock.top - lastRect.top;
      if (Math.abs(dx) >= 1 || Math.abs(dy) >= 1) {
        clockEl.style.transformOrigin = '0 0';
        clockEl.animate(
          [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
          { duration: 620, easing: 'cubic-bezier(0.16, 1, 0.3, 1)', fill: 'none' }
        );
      }
    }
    if (metaEl !== null && first.meta !== undefined) {
      flipTo(metaEl, first.meta, rectOf(metaEl), 480, 'cubic-bezier(0.16, 1, 0.3, 1)', false);
    }
    if (actionsEl !== null && first.actions !== undefined) {
      flipTo(actionsEl, first.actions, rectOf(actionsEl), 480, 'cubic-bezier(0.16, 1, 0.3, 1)', false);
    }
    // 控制区整体随模式切换：横向平移由 CSS width/margin-left 过渡负责，
    // 这里仅对纵向（margin-top:auto 导致的位置变化）做非线性的纯位移 FLIP
    const fixedEl = fixedRef.current;
    if (fixedEl !== null && first.fixed !== undefined) {
      const lastRect: FlipRect = rectOf(fixedEl);
      const dy: number = first.fixed.top - lastRect.top;
      if (Math.abs(dy) > 2) {
        fixedEl.style.transformOrigin = '0 0';
        fixedEl.animate(
          [{ transform: `translate(0px, ${dy}px)` }, { transform: 'none' }],
          { duration: 600, easing: 'cubic-bezier(0.16, 1, 0.3, 1)', fill: 'both' }
        );
      }
    }
    prevModeRef.current = viewMode;
  }, [viewMode]);

  /** 记录顶部标题栏高度与底部控制区高度（CSS 变量 --top-h / --fixed-h，供歌词层避让） */
  useLayoutEffect(() => {
    const rootEl = rootRef.current;
    if (rootEl === null) {
      return;
    }
    const update = (): void => {
      const topEl = topRef.current;
      const fixedEl = fixedRef.current;
      if (topEl !== null) {
        rootEl.style.setProperty('--top-h', `${topEl.getBoundingClientRect().height}px`);
      }
      if (fixedEl !== null) {
        rootEl.style.setProperty('--fixed-h', `${fixedEl.getBoundingClientRect().height}px`);
      }
    };
    update();
    const ro = new ResizeObserver(update);
    if (topRef.current !== null) {
      ro.observe(topRef.current);
    }
    if (fixedRef.current !== null) {
      ro.observe(fixedRef.current);
    }
    return (): void => {
      ro.disconnect();
    };
  }, []);

  // ===================== 无触摸自动隐藏 =====================

  const clearHideTimer = useCallback((): void => {
    if (hideTimerRef.current !== 0) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = 0;
    }
  }, []);

  /** 显示控制层并重置隐藏计时（大屏横屏下控制区常驻，不自动隐藏） */
  const armHideTimer = useCallback((): void => {
    if (isLargeLandscapeRef.current) {
      return;
    }
    clearHideTimer();
    setUiHidden(false);
    hideTimerRef.current = window.setTimeout((): void => {
      hideTimerRef.current = 0;
      setUiHidden(true);
    }, 4000);
  }, [clearHideTimer]);

  /** 立即隐藏控制层（清空隐藏计时并触发淡出动画；大屏横屏下不隐藏） */
  const hideControls = useCallback((): void => {
    if (isLargeLandscapeRef.current) {
      return;
    }
    clearHideTimer();
    setUiHidden(true);
  }, [clearHideTimer]);

  /** 仅歌词页自动隐藏；切回播放页始终显示 */
  useEffect(() => {
    inLyricsRef.current = viewMode === 'lyrics';
    if (viewMode === 'lyrics') {
      armHideTimer();
    } else {
      clearHideTimer();
      setUiHidden(false);
      leaveManualMode(false);
    }
    return (): void => {
      clearHideTimer();
    };
  }, [viewMode, armHideTimer, clearHideTimer, leaveManualMode]);

  /** 卸载时清理手动滚动恢复计时器 */
  useEffect(() => {
    return (): void => {
      if (manualTimerRef.current !== 0) {
        window.clearTimeout(manualTimerRef.current);
        manualTimerRef.current = 0;
      }
    };
  }, []);

  /** 事件目标是否位于歌词滚动区域（LyricPlayer 容器）内 */
  const isInLyricArea = useCallback((target: EventTarget | null): boolean => {
    return target instanceof Element && target.closest('.lyric-player-wrap') !== null;
  }, []);

  /** 判断按下目标是否是可拖动窗口的空白区域：
   *  只要不在任何交互控件内（按钮/封面/时钟/进度条/歌词/面板/窗口控制），
   *  就视为可拖动——播放页封面四周留白、歌词页标题栏与歌词外间隙都能拖。 */
  const isWindowDragHandle = useCallback((target: EventTarget | null): boolean => {
    if (!(target instanceof Element)) return false;
    return target.closest(
      'button, .flip-cover, .amll-clock, .player-track-row, .progress-track, ' +
      '.lyric-player-wrap, .player-fixed, .window-controls, .more-sheet, .menu-backdrop, .toast'
    ) === null;
  }, []);

  /** 结束窗口拖拽（全局抬起 / 指针取消 / 失焦时调用） */
  const endWindowDrag = useCallback((): void => {
    if (windowDraggingRef.current) {
      windowDraggingRef.current = false;
      nativeDragEnd();
    }
  }, []);

  /** 指针/触摸按下：歌词区域内先记录手势起点（不唤起控制栏，滚动/轻点在抬起时判定）；其余区域直接唤起。
   *  若按在窗口空白拖拽区则启动无边框窗口拖拽。 */
  const onGesturePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>): void => {
    // 窗口拖拽：非交互空白处按下即开始拖动
    if (isWindowDragHandle(e.target)) {
      windowDraggingRef.current = true;
      nativeDragStart(e.pointerId);
    }
    if (!inLyricsRef.current) {
      return;
    }
    if (isInLyricArea(e.target)) {
      lyricGestureRef.current = { x: e.clientX, y: e.clientY, scrolled: false, reveal: false };
      return;
    }
    lyricGestureRef.current = null;
    armHideTimer();
  }, [isWindowDragHandle, isInLyricArea, armHideTimer]);

  /** 指针/触摸移动：歌词区域内位移超过阈值即视为滚动。
   *  手指向上（歌词滚向下方后续内容）→ 控制栏若正开着则立即触发隐藏动画，保持沉浸；
   *  手指向下（歌词滚回上方已播内容）→ 唤起控制栏。
   *  任意方向的手动滚动都会进入"手动滚动模式"（冻结歌词、关闭模糊，3s 无滚动后恢复）。 */
  const onGesturePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>): void => {
    const g = lyricGestureRef.current;
    if (g === null) {
      return;
    }
    const dy: number = e.clientY - g.y;
    if (!g.scrolled && (Math.abs(e.clientX - g.x) > 10 || Math.abs(dy) > 10)) {
      g.scrolled = true;
    }
    if (g.scrolled) {
      enterManualMode();
    }
    if (g.scrolled && dy < -10) {
      if (!uiHidden) {
        hideControls();
      }
    } else if (g.scrolled && dy > 10 && !g.reveal) {
      g.reveal = true;
      armHideTimer();
    }
  }, [armHideTimer, hideControls, uiHidden, enterManualMode]);

  /** 指针/触摸抬起：歌词区域内的轻点（非滚动）视为普通手势 → 唤起控制栏；
   *  向下滚动（回看）已唤起时重续计时；向上滚动（浏览后续）不唤起。 */
  const onGesturePointerUp = useCallback((): void => {
    endWindowDrag();
    const g = lyricGestureRef.current;
    lyricGestureRef.current = null;
    if (g !== null && (!g.scrolled || g.reveal)) {
      armHideTimer();
    }
  }, [armHideTimer, endWindowDrag]);

  /** 窗口拖拽兜底：指针可能在应用外抬起，用全局监听确保一定结束拖拽 */
  useEffect(() => {
    window.addEventListener('pointerup', endWindowDrag);
    window.addEventListener('blur', endWindowDrag);
    return (): void => {
      window.removeEventListener('pointerup', endWindowDrag);
      window.removeEventListener('blur', endWindowDrag);
    };
  }, [endWindowDrag]);

  /** 鼠标移动：歌词区域悬停不打扰，其余区域移动唤起控制栏 */
  const onGestureMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>): void => {
    if (!inLyricsRef.current || isInLyricArea(e.target)) {
      return;
    }
    armHideTimer();
  }, [isInLyricArea, armHideTimer]);

  // ===================== 桥接回调 =====================

  /** 原生 → Web：播放信息更新 */
  const onPlaybackUpdate = useCallback((p: NowPlayingInfo): void => {
    // 补偿桥接延迟：position 是原生推算时刻的值，按 syncAt 与当前时间差修正，
    // 避免歌词进度比真实播放慢（应用重进/状态刷新时尤其明显）
    const compensated: number = p.syncAt > 0
      ? p.position + (Date.now() - p.syncAt)
      : p.position;
    // 注意：不要在这里逐条写日志（500ms 一次 IPC + 磁盘追加会拖慢主进程）
    const newKey: string = `${p.title}\u0001${p.artist}`;
    setPlayback(p);
    // 拖动进度条期间：不覆盖拖动预览位置，其余状态正常更新
    if (!progressDraggingRef.current) {
      baseRef.current = { position: compensated, state: p.state, syncTime: performance.now() };
      setCurrentTime(Math.floor(compensated));
    }
    if (p.state === 'idle') {
      songKeyRef.current = '';
      setLyricLines([]);
      setHasLyric(false);
      leaveManualMode(false);
      return;
    }
    if (newKey !== songKeyRef.current) {
      // 切歌：清空歌词，请求新歌词（歌名+时长双重匹配，由原生侧校验时长）
      songKeyRef.current = newKey;
      setLyricLines([]);
      setHasLyric(false);
      leaveManualMode(false);
      nativeFetchLyric(p.title, p.artist, p.duration);
    }
  }, [leaveManualMode]);

  /** 原生 → Web：歌词获取成功 */
  const onLyricResult = useCallback((result: LyricFetchResult): void => {
    const lines: LyricLine[] = parseLyric(result.rawText, result.format);
    // 净化：剔除作词/作曲/制作人 等制作信息行
    const cleanLines: LyricLine[] = lines.filter((l: LyricLine): boolean => !isCreditLine(l));
    nativeLog(`[HomoLyrics] onLyricResult format=${result.format} source=${result.source} lines=${lines.length} clean=${cleanLines.length}`);
    setLyricLines(cleanLines);
    setHasLyric(cleanLines.length > 0);
  }, []);

  /** 原生 → Web：歌词获取失败（全部源） */
  const onLyricError = useCallback((message: string): void => {
    nativeLog(`[HomoLyrics] onLyricError: ${message}`);
    setLyricLines([]);
    setHasLyric(false);
  }, []);

  /** 原生 → Web：封面单独更新 */
  const onCoverUpdate = useCallback((coverBase64: string): void => {
    setPlayback((prev: NowPlayingInfo): NowPlayingInfo => ({
      ...prev,
      coverBase64,
    }));
  }, []);

  /** 原生 → Web：低频音量更新（驱动背景律动） */
  const onLowFreqUpdate = useCallback((v: number): void => {
    setLowFreqVolume(v);
  }, []);

  /**
   * 系统状态栏文字颜色自适应：检测上方 safearea 背景深浅。
   * - 封面平均亮度 × 顶部模糊/渐变压暗系数 估出顶部观感亮度
   * - 无封面（黑底）→ 白字；亮度高（背景浅）→ 深色文字
   */
  useEffect(() => {
    let cancelled = false;
    const decide = async (): Promise<void> => {
      let effective = 0;
      const cover = playback.coverBase64;
      if (cover.length > 0) {
        const lum: number | null = await computeCoverLuminance(cover);
        if (!cancelled && lum !== null) {
          // 歌词页顶部有 45% 黑渐变 → 更暗；播放页直接显示模糊封面 → 略亮
          effective = lum * (viewMode === 'lyrics' ? 0.55 : 0.7);
        }
      }
      if (!cancelled) {
        const darkText: boolean = effective > 150;
        nativeSetStatusBarStyle(darkText);
      }
    };
    decide();
    return (): void => {
      cancelled = true;
    };
  }, [playback.coverBase64, viewMode]);

  /** 时间格式化 mm:ss（负数显示 -mm:ss） */
  const fmtTime = (ms: number): string => {
    const absMs: number = Math.max(0, Math.floor(ms));
    const totalSec: number = Math.floor(absMs / 1000);
    const m: number = Math.floor(totalSec / 60);
    const s: number = totalSec % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  /**
   * 逐位数字渲染：每位数字独立动画单元格；数值变化时旧数字下沉消失、新数字从上方
   * 下沉进入（统一下沉方向，带回弹与模糊过渡）。
   * 延迟按"数字位"计数（分隔符/负号不占位），使左右两侧当前/剩余时间同步变化，
   * 且每侧内部数字按从左到右 +40ms 顺序播放。
   */
  const renderDigits = (str: string, isNegative?: boolean): React.ReactElement[] => {
    const cells: React.ReactElement[] = [];
    let digitPos: number = 0;
    const chars: string[] = str.split('');
    for (let i = 0; i < chars.length; i++) {
      const ch: string = chars[i];
      if (ch === ':' || (isNegative === true && i === 0)) {
        cells.push(<span key={`sep-${i}`} className="digit-cell sep">{ch}</span>);
        continue;
      }
      const delay: number = digitPos * 40;
      digitPos++;
      cells.push(<DigitCell key={`d-${i}`} value={ch} delay={delay} />);
    }
    return cells;
  };

  /** 从指针事件计算轨道内 0-1 比例 */
  const ratioFromPointer = (e: React.PointerEvent<HTMLDivElement>, el: HTMLDivElement): number => {
    const rect: DOMRect = el.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  };

  /** 进度条按下：进入拖动（加粗），预览目标位置 */
  const onProgressPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (playback.duration <= 0) {
      return;
    }
    progressDraggingRef.current = true;
    setProgressPressed(true);
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // 忽略捕获失败
    }
    const ms: number = Math.round(ratioFromPointer(e, e.currentTarget) * playback.duration);
    setCurrentTime(ms);
  };

  /** 进度条拖动中：实时预览目标位置（无过渡跟随手指） */
  const onProgressPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!progressDraggingRef.current || playback.duration <= 0) {
      return;
    }
    const ms: number = Math.round(ratioFromPointer(e, e.currentTarget) * playback.duration);
    setCurrentTime(ms);
  };

  /** 进度条释放：发送跳转命令并恢复
   *  更新播放基准为最终目标，避免 RAF 用拖动前的旧基准覆盖显示 */
  const onProgressPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!progressDraggingRef.current) {
      return;
    }
    progressDraggingRef.current = false;
    setProgressPressed(false);
    if (playback.duration <= 0) {
      return;
    }
    const ms: number = Math.round(ratioFromPointer(e, e.currentTarget) * playback.duration);
    baseRef.current = { position: ms, state: playback.state, syncTime: performance.now() };
    setCurrentTime(ms);
    nativeSeekTo(ms);
    leaveManualMode(true, ms);
  };

  /** 封面按下：记录滑动起点并捕获指针（保证抬起事件落在封面上） */
  const onCoverPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    coverSwipeStartXRef.current = e.clientX;
    coverSwipeStartYRef.current = e.clientY;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // 忽略捕获失败
    }
  };

  /** 封面抬起：点击返回播放页；播放页上滑进入歌词页；左滑/右滑切换歌曲 */
  const onCoverPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (coverSwipeStartXRef.current === null) {
      return;
    }
    const startX: number = coverSwipeStartXRef.current;
    const startY: number = coverSwipeStartYRef.current ?? e.clientY;
    coverSwipeStartXRef.current = null;
    coverSwipeStartYRef.current = null;
    const dx: number = e.clientX - startX;
    const dy: number = e.clientY - startY;
    // 位移很小的点击：歌词页时返回播放页
    if (Math.abs(dx) < 40 && Math.abs(dy) < 40) {
      if (viewMode === 'lyrics') {
        changeMode('player');
      }
      return;
    }
    // 垂直滑动：播放页上滑进入歌词页；歌词页下滑返回播放页
    if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 50) {
      if (dy < 0 && viewMode === 'player') {
        changeMode('lyrics');
        return;
      }
      if (dy > 0 && viewMode === 'lyrics') {
        changeMode('player');
        return;
      }
    }
    // 水平滑动判定：左滑下一曲，右滑上一曲
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 50) {
      if (dx < 0) {
        nativeSendCommand('playNext');
        nextIconRef.current?.pulse();
      } else {
        nativeSendCommand('playPrevious');
        prevIconRef.current?.pulse();
      }
    }
  };

  /** 播放/暂停切换 */
  const onPlayPause = (): void => {
    nativeSendCommand(playing ? 'pause' : 'play');
  };

  /** 短暂提示（收藏/取消收藏反馈） */
  const showToast = (message: string): void => {
    setToast(message);
    if (toastTimerRef.current !== 0) {
      window.clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = window.setTimeout((): void => {
      toastTimerRef.current = 0;
      setToast('');
    }, 1800);
  };

  /** 原生 → Web：播放队列更新（播放列表控件已移除，保留空实现满足桥接契约） */
  const onQueueUpdate = useCallback((_items: QueueItem[]): void => { /* no-op */ }, []);

  // ===================== 更多面板：字体 / 时差 / 歌词源优先级 =====================

  /** 歌词字体大小档位步进（dir=1 增大 / -1 减小） */
  const stepFontScale = (dir: number): void => {
    const idx: number = FONT_SCALE_STEPS.indexOf(fontScale);
    const nextIdx: number = Math.max(0, Math.min(FONT_SCALE_STEPS.length - 1, (idx < 0 ? 2 : idx) + dir));
    const next: number = FONT_SCALE_STEPS[nextIdx];
    if (next !== fontScale) {
      setFontScale(next);
      persistNumericPreference(PREF_KEY_FONT_SCALE, next);
    }
  };

  /** 歌词时差步进（dir=1 提前 / -1 延后，500ms 步进，±10s 限幅） */
  const stepOffset = (dir: number): void => {
    const next: number = Math.max(-OFFSET_LIMIT_MS, Math.min(OFFSET_LIMIT_MS, lyricOffsetMs + dir * OFFSET_STEP_MS));
    if (next !== lyricOffsetMs) {
      setLyricOffsetMs(next);
      persistNumericPreference(PREF_KEY_OFFSET_MS, next);
    }
  };

  /** 重置歌词时差 */
  const resetOffset = (): void => {
    setLyricOffsetMs(0);
    persistNumericPreference(PREF_KEY_OFFSET_MS, 0);
  };

  /** 时差显示文案（+1.0s / -0.5s / 0s） */
  const formatOffset = (ms: number): string => {
    if (ms === 0) return '0s';
    return `${ms > 0 ? '+' : '-'}${(Math.abs(ms) / 1000).toFixed(1)}s`;
  };

  /** 上移/下移歌词源优先级 */
  const moveSource = (index: number, dir: -1 | 1): void => {
    const next: string[] = sourcesConfig.priority.slice();
    const target: number = index + dir;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setSourcesConfig(prev => ({ ...prev, priority: next }));
    nativeSetLyricSources(next);
  };

  /** 注册桥接处理器并通知原生就绪 */
  useEffect(() => {
    registerAppHandlers({
      onPlaybackUpdate,
      onLyricResult,
      onLyricError,
      onCoverUpdate,
      onLowFreqUpdate,
      onQueueUpdate,
    });
    // 读取歌词源优先级配置
    const config = nativeGetLyricSources();
    if (config) setSourcesConfig(config);
    nativeLog('[HomoLyrics] App mounted, notifying native ready');
    nativeNotifyReady();
    // 注意：此处清理不得取消 RAF 循环，否则 effect 因处理器引用变化重跑时会停掉进度驱动
  }, [onPlaybackUpdate, onLyricResult, onLyricError, onCoverUpdate, onLowFreqUpdate, onQueueUpdate]);

  /** 背景渲染延后到首帧之后挂载，缩短窗口出现前的空白时间 */
  useEffect(() => {
    let raf2 = 0;
    const raf1 = window.requestAnimationFrame((): void => {
      raf2 = window.requestAnimationFrame((): void => setBgReady(true));
    });
    return (): void => {
      window.cancelAnimationFrame(raf1);
      window.cancelAnimationFrame(raf2);
    };
  }, []);

  /** 歌词字体大小：通过 wrap 元素覆盖 AMLL 基础字号变量 */
  useEffect(() => {
    const el = lyricWrapRef.current;
    if (el === null) return;
    if (fontScale === 1) {
      el.style.removeProperty('--amll-lp-font-size');
    } else {
      el.style.setProperty('--amll-lp-font-size', `calc(max(max(5vh, 2.5vw), 12px) * ${fontScale})`);
    }
  }, [fontScale]);

  return (
    <div
      className={`app-root${uiHidden ? ' ui-hidden' : ''}`}
      ref={rootRef}
      onPointerDown={onGesturePointerDown}
      onPointerMove={onGesturePointerMove}
      onPointerUp={onGesturePointerUp}
      onPointerCancel={onGesturePointerUp}
      onMouseMove={onGestureMouseMove}
    >
      {/* 窗口控制：鼠标移到右上角时滑出最小化/关闭按钮（Electron 无边框窗口） */}
      <div className="window-controls">
        <button className="window-btn minimize-btn" onClick={(): void => nativeMinimize()} aria-label="最小化窗口">
          <i className="fa-solid fa-minus" aria-hidden="true" />
        </button>
        <button className="window-btn close-btn" onClick={(): void => nativeClose()} aria-label="关闭窗口">
          <i className="fa-solid fa-xmark" aria-hidden="true" />
        </button>
      </div>

      <div className="bg-render">
        {bgReady && (
          <BackgroundRender
            renderer={PixiRenderer}
            album={playback.coverBase64.length > 0 ? playback.coverBase64 : undefined}
            playing={playing}
            hasLyric={hasLyric}
            lowFreqVolume={lowFreqVolume}
            renderScale={0.5}
            fps={60}
          />
        )}
      </div>

      {/* 统一视图：顶部动画区 + 歌词层 + 底部固定控制区 */}
      <div className={`player-view ${playing ? 'playing' : 'paused'}${viewMode === 'lyrics' ? ' lyrics-mode' : ''}`}>
        <div className="player-top" ref={topRef}>
          {showClock && (
            <div
              ref={clockRef}
              className={`amll-clock${clockSeconds ? ' with-seconds' : ''}`}
              style={{ fontSize: `${clockFontSize}px`, width: `${clockWidth}px` }}
              onClick={(): void => {
                const next: boolean = !clockSeconds;
                setClockSeconds(next);
                persistPreference(PREF_KEY_CLOCK_SECONDS, next);
              }}
              onContextMenu={(e: React.MouseEvent): void => {
                e.preventDefault();
                setShowClock(false);
                persistPreference(PREF_KEY_CLOCK, false);
                showToast('时钟已隐藏，可在“更多 → 显示时钟”中恢复');
              }}
              title="点击切换秒数 · 右键隐藏时钟"
            >
              {clockText}
            </div>
          )}
          <div className="flip-cover" ref={coverWrapRef}
            onPointerDown={onCoverPointerDown}
            onPointerUp={onCoverPointerUp}>
            <div className="player-cover">
              {playback.coverBase64.length > 0
                ? <img src={playback.coverBase64} alt="cover" />
                : <div className="cover-placeholder" />}
            </div>
          </div>
          <div className="player-track-row">
            <div className="player-track-meta" ref={metaRef}>
              <MarqueText text={playback.title || '未在播放'} className="player-title" />
              <MarqueText text={playback.artist || ' '} className="player-artist" />
            </div>
            <div className="player-track-actions" ref={actionsRef}>
              {hasTranslation && (
                <button
                  className={`icon-btn tool-ibtn${showTranslation ? ' active' : ''}`}
                  onClick={(): void => {
                    const next: boolean = !showTranslation;
                    setShowTranslation(next);
                    persistPreference(PREF_KEY_TRANSLATION, next);
                  }}
                  aria-label="显示翻译">
                  <i className="fa-solid fa-language" aria-hidden="true" />
                </button>
              )}
              {hasRomaji && (
                <button
                  className={`icon-btn tool-ibtn${showRomaji ? ' active' : ''}`}
                  onClick={(): void => {
                    const next: boolean = !showRomaji;
                    setShowRomaji(next);
                    persistPreference(PREF_KEY_ROMAJI, next);
                  }}
                  aria-label="显示罗马音">
                  <i className="fa-solid fa-spell-check" aria-hidden="true" />
                </button>
              )}
              <button className="icon-btn more-btn" onClick={(): void => setMoreOpen(true)} aria-label="更多">
                <span className="dots"><i /><i /><i /></span>
              </button>
            </div>
          </div>
        </div>

        {/* 歌词层：仅歌词页可见；LyricPlayer 常驻但禁用逐帧动画以省性能 */}
        <div className="lyrics-layer">
          <div className="lyric-player-wrap" ref={lyricWrapRef}>
            <LyricPlayer
              ref={lyricPlayerRef}
              className={`lyric-player-el${showTranslation ? '' : ' no-translation'}${showRomaji ? '' : ' no-romaji'}`}
              lyricLines={lyricLines}
              currentTime={Math.max(0, (manualMode ? freezeTime : currentTime) + lyricOffsetMs)}
              playing={playing}
              disabled={viewMode !== 'lyrics'}
              onLyricLineClick={onLyricLineClick}
              enableBlur={!manualMode}
              enableScale
              wordFadeWidth={0.5}
              alignAnchor="center"
              alignPosition={isLandscape ? 0.45 : 0.38}
              bottomLine={
                <div className="bottom-line">
                  {playback.title || '未检测到播放'}
                  {playback.artist.length > 0 ? ` · ${playback.artist}` : ''}
                </div>
              }
            />
          </div>
        </div>

        {/* 底部固定控制区：播放页/歌词页位置不变，歌词页无触摸时淡出 */}
        <div className="player-fixed" ref={fixedRef}>
          <div className="player-progress">
            <div
              className={`progress-track${progressPressed ? ' active' : ''}`}
              onPointerDown={onProgressPointerDown}
              onPointerMove={onProgressPointerMove}
              onPointerUp={onProgressPointerUp}
              onPointerCancel={onProgressPointerUp}
            >
              <div className={`progress-fill${playback.duration > 0 && currentTime / playback.duration >= 0.995 ? ' full' : ''}`}
                style={{ width: `${playback.duration > 0 ? Math.min(100, currentTime / playback.duration * 100) : 0}%` }} />
            </div>
            <div className="progress-time-row">
              <div className="progress-time">{renderDigits(fmtTime(currentTime))}</div>
              <div className="progress-time">
                {playback.duration > 0
                  ? renderDigits(`-${fmtTime(playback.duration - currentTime)}`, true)
                  : <span className="digit-cell sep">-0:00</span>}
              </div>
            </div>
          </div>

          <div className="player-controls">
            <button className="ctl-btn" onClick={(): void => {
              nativeSendCommand('playPrevious');
              prevIconRef.current?.pulse();
            }}>
              <NextPrevIcon ref={prevIconRef} iconClass="fa-solid fa-backward" direction="prev" />
            </button>
            <button className="ctl-btn main" onClick={onPlayPause}>
              <span className={`ctl-icon${playing ? ' playing' : ' paused'}`}>
                <i className="fa-solid fa-pause ctl-ico" aria-hidden="true" />
                <i className="fa-solid fa-play ctl-ico" aria-hidden="true" />
              </span>
            </button>
            <button className="ctl-btn" onClick={(): void => {
              nativeSendCommand('playNext');
              nextIconRef.current?.pulse();
            }}>
              <NextPrevIcon ref={nextIconRef} iconClass="fa-solid fa-forward" direction="next" />
            </button>
          </div>

          <div className="player-bottom">
            <button
              className={`bottom-btn lyrics-btn${viewMode === 'lyrics' ? ' active' : ''}`}
              onClick={toggleLyrics}
              aria-label="歌词">
              <span className="bottom-icon combo">
                <i className="fa-regular fa-message" aria-hidden="true" />
                <i className="fa-solid fa-quote-right" aria-hidden="true" />
              </span>
            </button>
            <button className="bottom-btn fullscreen-btn" onClick={(): void => nativeToggleFullscreen()}
              aria-label={isFullscreen ? '退出全屏' : '全屏'}>
              <i className={`fa-solid ${isFullscreen ? 'fa-compress' : 'fa-expand'} bottom-icon`} aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>

      {toast.length > 0 && (
        <div className="toast">{toast}</div>
      )}

      {/* 歌词设置面板（更多按钮）：字体大小 / 时差 / 歌词源优先级 */}
      {moreOpen && (
        <div className="menu-backdrop" onPointerDown={(): void => setMoreOpen(false)}>
          <div className="more-sheet" onPointerDown={(e: React.PointerEvent<HTMLDivElement>): void => e.stopPropagation()}>
            <div className="more-header">
              <span className="more-title">歌词设置</span>
              <button className="queue-close" onClick={(): void => setMoreOpen(false)} aria-label="关闭">
                <i className="fa-solid fa-xmark" aria-hidden="true" />
              </button>
            </div>
            <div className="more-body">
              <div className="more-row">
                <span className="more-label">显示时钟</span>
                <button
                  className={`toggle-switch${showClock ? ' on' : ''}`}
                  onClick={(): void => {
                    const next: boolean = !showClock;
                    setShowClock(next);
                    persistPreference(PREF_KEY_CLOCK, next);
                  }}
                  aria-label="显示时钟"
                  aria-pressed={showClock}>
                  <span className="toggle-knob" />
                </button>
              </div>
              <div className="more-row">
                <span className="more-label">字体大小</span>
                <div className="stepper">
                  <button className="step-btn" onClick={(): void => stepFontScale(-1)} aria-label="减小字体">
                    <i className="fa-solid fa-minus" aria-hidden="true" />
                  </button>
                  <span className="step-value">{Math.round(fontScale * 100)}%</span>
                  <button className="step-btn" onClick={(): void => stepFontScale(1)} aria-label="增大字体">
                    <i className="fa-solid fa-plus" aria-hidden="true" />
                  </button>
                </div>
              </div>
              <div className="more-row">
                <span className="more-label">歌词时差</span>
                <div className="stepper">
                  <button className="step-btn" onClick={(): void => stepOffset(-1)} aria-label="歌词延后">
                    <i className="fa-solid fa-minus" aria-hidden="true" />
                  </button>
                  <span className={`step-value${lyricOffsetMs !== 0 ? ' changed' : ''}`}>{formatOffset(lyricOffsetMs)}</span>
                  <button className="step-btn" onClick={(): void => stepOffset(1)} aria-label="歌词提前">
                    <i className="fa-solid fa-plus" aria-hidden="true" />
                  </button>
                </div>
              </div>
              {lyricOffsetMs !== 0 && (
                <button className="more-reset" onClick={resetOffset}>重置时差</button>
              )}
              <div className="more-section-title">歌词源优先级（高 → 低）</div>
              <div className="source-list">
                {sourcesConfig.priority.map((source: string, index: number): React.ReactElement => (
                  <div key={source} className="source-row">
                    <span className="source-rank">{index + 1}</span>
                    <span className="source-name">{sourcesConfig.labels[source] || source}</span>
                    <div className="source-actions">
                      <button className="source-btn" onClick={(): void => moveSource(index, -1)} disabled={index === 0} aria-label="上移">
                        <i className="fa-solid fa-chevron-up" aria-hidden="true" />
                      </button>
                      <button className="source-btn" onClick={(): void => moveSource(index, 1)} disabled={index === sourcesConfig.priority.length - 1} aria-label="下移">
                        <i className="fa-solid fa-chevron-down" aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const rootElement: HTMLElement | null = document.getElementById('root');
if (rootElement) {
  const root = createRoot(rootElement);
  root.render(<App />);
}
