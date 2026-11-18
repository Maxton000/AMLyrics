/**
 * 多源歌词获取 —— 从鸿蒙项目 AmllLyricProvider.ets 逐条移植到 Node.js。
 *
 * 歌词源：ncm(网易云) / qq_music(QQ) / kugou(酷狗) / amll_ttml(AMLL 逐字库)。
 * 默认优先级：ncm > qq_music > kugou（可在「更多」面板中调整）。
 * - 各源并发拉取，按用户设定的优先级顺序决定采用：高优先级若在宽限期内命中则优先采用
 * - 网易云 lyrics 用 yv=-1 拿 yrc/ytlrc、lrc/tlyric，并用 AmllTtmlBuilder 合并翻译为 TTML
 *   （这是「翻译按钮检测不到」的根因修复：只有 x-translation 才会产出 translatedLyric）
 * - 每源独立 try-catch、独立 8s 超时；成功结果缓存（上限 30 条）
 * - 支持代次取消：切歌后旧代次的迟到结果被丢弃
 */
'use strict';

const { buildFromLrc, buildFromYrc } = require('./ttml-builder.cjs');

const UA = 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36';
const KUGOU_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const TIMEOUT_MS = 8000;
const PRIORITY_GRACE_MS = 2500;
const CACHE_MAX = 30;
const SEARCH_LIMIT = 5;

const AMLLDB_SEARCH_URL = 'https://lyrics.amzcd.top/api/search-lyrics';
const AMLLDB_RAW_BASE = 'https://lyrics.amzcd.top/raw-lyrics';
const AMLLDB_REFERER = 'https://lyrics.amzcd.top';
const QQ_SEARCH_URL = 'https://c.y.qq.com/soso/fcgi-bin/client_search_cp';
const QQ_LYRIC_URL = 'https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg';
const QQ_REFERER = 'https://y.qq.com';
const NCM_SEARCH_URL = 'https://music.163.com/api/search/get';
const NCM_LYRIC_URL = 'https://music.163.com/api/song/lyric';
const NCM_REFERER = 'https://music.163.com';
const KG_SEARCH_URL = 'https://songsearch.kugou.com/song_search_v2';
const KG_LYRIC_SEARCH_URL = 'https://krcs.kugou.com/search';
const KG_LYRIC_DOWNLOAD_URL = 'https://lyrics.kugou.com/download';
const KG_REFERER = 'https://www.kugou.com/';

/** 所有可选歌词源及默认优先级（高 → 低） */
const ALL_SOURCES = ['ncm', 'qq_music', 'kugou', 'amll_ttml'];
const SOURCE_LABELS = {
  ncm: '网易云音乐',
  qq_music: 'QQ 音乐',
  kugou: '酷狗音乐',
  amll_ttml: 'AMLL 逐字库'
};

let sourcePriority = ['ncm', 'qq_music', 'kugou', 'amll_ttml'];
const cache = new Map();
let latestGeneration = 0;

function log(message) {
  console.log('[LyricProvider] ' + message);
}

/** 更新歌词源优先级（来自更多面板设置）。传入数组会过滤去重并补全缺失源。 */
function setSourcePriority(priority) {
  if (!Array.isArray(priority)) return;
  const next = priority.filter(s => ALL_SOURCES.includes(s));
  for (const s of ALL_SOURCES) if (!next.includes(s)) next.push(s);
  sourcePriority = next;
  cache.clear(); // 优先级变化后清空缓存，立即按新顺序重试
  log('source priority updated: ' + sourcePriority.join(' > '));
}

function getSourcePriority() {
  return sourcePriority.slice();
}

async function httpRequest(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: options.method || 'GET',
      headers: { 'User-Agent': options.ua || UA, ...(options.headers || {}) },
      body: options.body,
      signal: controller.signal
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return options.text ? await response.text() : await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function normalizeMatchText(text) {
  return String(text || '')
    .replace(/\([^)]*\)|\[[^\]]*\]|\{[^}]*\}|（[^）]*）|【[^】]*】|《[^》]*》/g, '')
    .toLowerCase()
    .replace(/[\s\-_&/.,，。、!！?？:：;；'"·‘’“”]/g, '');
}

function isTextMatch(a, b) {
  const na = normalizeMatchText(a);
  const nb = normalizeMatchText(b);
  if (na.length === 0 || nb.length === 0) return true;
  return na.includes(nb) || nb.includes(na);
}

function isArtistMatch(sysArtist, candArtist) {
  const na = normalizeMatchText(sysArtist);
  const nb = normalizeMatchText(candArtist);
  if (na.length === 0 || nb.length === 0) return true;
  return nb.includes(na);
}

function isSongMatch(sysTitle, sysArtist, sysDuration, candTitle, candArtist, candDurationMs) {
  if (sysDuration > 0 && candDurationMs > 0 && Math.abs(candDurationMs - sysDuration) > 2000) return false;
  if (candTitle && candTitle.length > 0 && !isTextMatch(sysTitle, candTitle)) return false;
  if (candArtist && candArtist.length > 0 && !isArtistMatch(sysArtist, candArtist)) return false;
  return true;
}

function joinArtistNames(artists) {
  if (!Array.isArray(artists)) return '';
  return artists.map(a => a && a.name ? a.name : '').filter(Boolean).join('/');
}

function parseTtmlTimeToMs(time) {
  const parts = String(time).trim().split(':');
  let h = 0, m = 0, s = 0;
  if (parts.length === 3) { h = Number(parts[0]); m = Number(parts[1]); s = Number(parts[2]); }
  else if (parts.length === 2) { m = Number(parts[0]); s = Number(parts[1]); }
  else if (parts.length === 1) { s = Number(parts[0]); }
  else return undefined;
  if (![h, m, s].every(Number.isFinite)) return undefined;
  return (h * 3600 + m * 60 + s) * 1000;
}

function parseTtmlDurationMs(text) {
  let maxMs;
  const re = /(?:begin|end)="([^"]+)"/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    const ms = parseTtmlTimeToMs(match[1]);
    if (ms !== undefined && (maxMs === undefined || ms > maxMs)) maxMs = ms;
  }
  return maxMs;
}

// ===================== 各歌词源 =====================

async function fetchAmllTtml(title, artist, duration) {
  try {
    const searchBody = JSON.stringify({ query: title, type: 'all' });
    const items = await httpRequest(AMLLDB_SEARCH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Referer': AMLLDB_REFERER, 'Origin': AMLLDB_REFERER },
      body: searchBody
    });
    if (!Array.isArray(items)) return undefined;
    for (const entry of items) {
      const candTitle = entry.title || '';
      const candArtist = Array.isArray(entry.artists) ? entry.artists.join('/') : (entry.artist || '');
      if (!isTextMatch(title, candTitle) || !isArtistMatch(artist, candArtist)) continue;
      if (!entry.id) continue;
      const ttml = await httpRequest(`${AMLLDB_RAW_BASE}/${entry.id}`, { text: true });
      if (!ttml || ttml.length === 0) continue;
      if (duration > 0) {
        const lyricDuration = parseTtmlDurationMs(ttml);
        if (lyricDuration !== undefined && lyricDuration > duration + 2000) continue;
      }
      return { rawText: ttml, format: 'TTML', source: 'amll_ttml' };
    }
    return undefined;
  } catch (error) {
    log('AMLL_TTML failed: ' + error.message);
    return undefined;
  }
}

/** 网易云：search → id → /api/song/lyric?yv=-1 → 翻译合并成 TTML（含 x-translation） */
async function fetchNcm(title, artist, duration) {
  try {
    const query = `${title} ${artist}`.trim();
    const url = `${NCM_SEARCH_URL}?s=${encodeURIComponent(query)}&type=1&offset=0&limit=${SEARCH_LIMIT}`;
    const search = await httpRequest(url, { headers: { Referer: NCM_REFERER } });
    const songs = search && search.result && search.result.songs;
    if (!Array.isArray(songs) || songs.length === 0) return undefined;
    let songId;
    for (const song of songs) {
      if (!isSongMatch(title, artist, duration, song.name, joinArtistNames(song.artists), song.duration)) continue;
      if (song.id !== undefined) { songId = song.id; break; }
    }
    if (songId === undefined) return undefined;

    // yv=-1 才返回 yrc/ytlrc 字段（yrc=1 无效）——与鸿蒙端一致
    const lyricUrl = `${NCM_LYRIC_URL}?id=${songId}&lv=-1&kv=-1&tv=-1&yv=-1`;
    const resp = await httpRequest(lyricUrl, { headers: { Referer: NCM_REFERER } });

    // 1) 逐字歌词优先：YRC + ytlrc → TTML（含翻译）
    const yrc = resp && resp.yrc && resp.yrc.lyric;
    if (typeof yrc === 'string' && yrc.length > 0 && !yrc.includes('暂无歌词')) {
      const ytlrc = resp && resp.ytlrc && resp.ytlrc.lyric || '';
      const ttml = ytlrc.length > 0 ? buildFromYrc(yrc, ytlrc) : '';
      if (ttml.length > 0) return { rawText: ttml, format: 'TTML', source: 'ncm' };
      return { rawText: yrc, format: 'YRC', source: 'ncm' };
    }
    // 2) 逐行歌词：LRC + tlyric → TTML（含翻译）
    const lrc = resp && resp.lrc && resp.lrc.lyric;
    if (typeof lrc === 'string' && lrc.length > 0 && !lrc.includes('暂无歌词')) {
      const tlyric = resp && resp.tlyric && resp.tlyric.lyric || '';
      const ttml = tlyric.length > 0 ? buildFromLrc(lrc, tlyric) : '';
      if (ttml.length > 0) return { rawText: ttml, format: 'TTML', source: 'ncm' };
      return { rawText: lrc, format: 'LRC', source: 'ncm' };
    }
    return undefined;
  } catch (error) {
    log('NCM failed: ' + error.message);
    return undefined;
  }
}

async function fetchQq(title, artist, duration) {
  try {
    const query = `${title} ${artist}`.trim();
    const searchUrl = `${QQ_SEARCH_URL}?w=${encodeURIComponent(query)}&format=json&n=${SEARCH_LIMIT}&cr=1`;
    const search = await httpRequest(searchUrl, { headers: { Referer: QQ_REFERER } });
    const list = search && search.data && search.data.song && search.data.song.list;
    if (!Array.isArray(list) || list.length === 0) return undefined;
    let songmid = '';
    for (const item of list) {
      const candDuration = item.interval > 0 ? item.interval * 1000 : 0;
      if (!isSongMatch(title, artist, duration, item.songname, joinArtistNames(item.singer), candDuration)) continue;
      if (item.songmid) { songmid = item.songmid; break; }
    }
    if (!songmid) return undefined;
    const lyricUrl = `${QQ_LYRIC_URL}?songmid=${songmid}&format=json&nobase64=0`;
    const resp = await httpRequest(lyricUrl, { headers: { Referer: QQ_REFERER } });
    if (!resp || resp.retcode !== 0 || !resp.lyric) return undefined;
    const decoded = Buffer.from(resp.lyric, 'base64').toString('utf8');
    if (decoded.length === 0) return undefined;
    // QQ 的转码歌词在 trans 字段（base64 LRC），若能解码则合并为 TTML 以启用翻译
    let rawText = decoded;
    let format = 'LRC';
    const transB64 = resp.trans;
    if (typeof transB64 === 'string' && transB64.length > 0) {
      try {
        const trans = Buffer.from(transB64, 'base64').toString('utf8');
        const ttml = buildFromLrc(decoded, trans);
        if (ttml.length > 0) { rawText = ttml; format = 'TTML'; }
      } catch { /* 翻译合并失败则回退原文 */ }
    }
    return { rawText, format, source: 'qq_music' };
  } catch (error) {
    log('QQ_MUSIC failed: ' + error.message);
    return undefined;
  }
}

/** 酷狗：song_search_v2 → hash → krcs/search(id,accesskey) → lyrics/download(lrc,base64) */
async function fetchKugou(title, artist, duration) {
  try {
    const query = `${title} ${artist}`.trim();
    const searchUrl = `${KG_SEARCH_URL}?keyword=${encodeURIComponent(query)}&page=1&pagesize=${SEARCH_LIMIT}&platform=WebFilter`;
    const search = await httpRequest(searchUrl, { ua: KUGOU_UA, headers: { Referer: KG_REFERER } });
    const list = search && search.data && search.data.lists;
    if (!Array.isArray(list) || list.length === 0) return undefined;
    let song;
    for (const item of list) {
      const candDuration = item.Duration > 0 ? item.Duration * 1000 : 0;
      if (!isSongMatch(title, artist, duration, item.SongName, item.SingerName, candDuration)) continue;
      if (item.FileHash) { song = item; break; }
    }
    if (!song) return undefined;

    const lyricSearchUrl = `${KG_LYRIC_SEARCH_URL}?ver=1&man=yes&client=mobi&keyword=&duration=${song.Duration * 1000}&hash=${song.FileHash}`;
    const lyricSearch = await httpRequest(lyricSearchUrl, { ua: KUGOU_UA, headers: { Referer: KG_REFERER } });
    const candidate = lyricSearch && Array.isArray(lyricSearch.candidates) && lyricSearch.candidates[0];
    if (!candidate || !candidate.id || !candidate.accesskey) return undefined;

    const downloadUrl = `${KG_LYRIC_DOWNLOAD_URL}?ver=1&client=pc&id=${candidate.id}&accesskey=${encodeURIComponent(candidate.accesskey)}&fmt=lrc&charset=utf8`;
    const resp = await httpRequest(downloadUrl, { ua: KUGOU_UA, headers: { Referer: KG_REFERER } });
    const content = resp && resp.content;
    if (typeof content !== 'string' || content.length === 0) return undefined;
    let decoded;
    try { decoded = Buffer.from(content, 'base64').toString('utf8'); } catch { return undefined; }
    if (decoded.length === 0) return undefined;
    return { rawText: decoded, format: 'LRC', source: 'kugou' };
  } catch (error) {
    log('KUGOU failed: ' + error.message);
    return undefined;
  }
}

const FETCHERS = {
  ncm: fetchNcm,
  qq_music: fetchQq,
  kugou: fetchKugou,
  amll_ttml: fetchAmllTtml
};

function toSourceResult(source, promise) {
  return promise.then(
    result => ({ source, result }),
    () => ({ source, result: undefined })
  );
}

/** 按优先级选取：高优先级源若在宽限期内命中则采用，否则取最先成功的低优先级源结果。 */
async function pickByPriority(sources, promiseMap) {
  // 等待首个成功（避免所有源都失败时长等待）
  const pending = sources.map(s => promiseMap[s]);
  let firstSuccessResult;
  const first = await new Promise(resolve => {
    let remaining = pending.length;
    let settled = false;
    for (const p of pending) {
      p.then(sr => {
        if (settled) return;
        if (sr.result !== undefined) {
          settled = true;
          resolve(sr);
        } else if (--remaining === 0) {
          settled = true;
          resolve(undefined);
        }
      });
    }
  });
  firstSuccessResult = first;
  if (!firstSuccessResult || !firstSuccessResult.result) return undefined;

  // 按用户优先级，从高到低给每个源一次「宽限期」：若它在宽限期内成功则采用
  for (const source of sources) {
    if (source === firstSuccessResult.source) {
      return firstSuccessResult.result;
    }
    const sr = await raceWithDelay(promiseMap[source], PRIORITY_GRACE_MS);
    if (sr && sr.result) return sr.result;
  }
  // 理论上不会到这里（firstSuccessResult 必属于 sources）
  return firstSuccessResult.result;
}

function raceWithDelay(promise, delayMs) {
  return new Promise(resolve => {
    let done = false;
    promise.then(sr => { if (!done) { done = true; resolve(sr); } });
    setTimeout(() => { if (!done) { done = true; resolve(undefined); } }, delayMs);
  });
}

function cacheResult(key, result) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, result);
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

/**
 * 按降级链获取歌词。
 * @param {string} title
 * @param {string} artist
 * @param {number} duration 系统时长（毫秒），<=0 跳过时长校验
 * @param {number} generation 请求代次，旧代次结果丢弃
 * @param {(result:object)=>void} onResult
 * @param {(message:string)=>void} onError
 */
async function fetchLyric(title, artist, duration, generation, onResult, onError) {
  latestGeneration = generation;
  if (!title || title.trim().length === 0) {
    onError('未找到歌词：缺少歌名');
    return;
  }
  const key = `${title}\u0001${artist}`;
  const cached = cache.get(key);
  if (cached) {
    log('cache hit: ' + key);
    if (generation === latestGeneration) onResult(cached);
    return;
  }

  const sources = getSourcePriority();
  const promiseMap = {};
  for (const source of sources) {
    promiseMap[source] = toSourceResult(source, FETCHERS[source](title, artist, duration));
  }

  const chosen = await pickByPriority(sources, promiseMap);
  if (generation !== latestGeneration) return;

  if (!chosen) {
    onError('未找到歌词：所有歌词源均未命中或网络不可用');
    return;
  }

  cacheResult(key, chosen);
  onResult(chosen);
}

module.exports = {
  fetchLyric,
  setSourcePriority,
  getSourcePriority,
  ALL_SOURCES,
  SOURCE_LABELS,
  isSongMatch,
  normalizeMatchText,
  joinArtistNames
};
