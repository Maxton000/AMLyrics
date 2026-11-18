/**
 * 联网歌曲信息/封面匹配 —— 仿照鸿蒙项目「拿到系统播放信息后再联网匹配」的思路。
 *
 * Windows SMTC 在网易云音乐桌面端上通常不提供 Thumbnail 与 Timeline，
 * 因此这里只把系统给到的 歌名 + 歌手 + 时长 作为查询条件，联网搜到最匹配的
 * 单曲后取专辑封面（网易云 /api/song/detail → album.picUrl，QQ → photo_new 直链），
 * 下载并转成 data URL 推给前端；同时用匹配到的时长兜底进度条。
 *
 * 匹配规则直接复用 lyric-provider（与鸿蒙 LyricProvider.ets 完全一致）。
 */
'use strict';

const { isSongMatch, normalizeMatchText, joinArtistNames } = require('./lyric-provider.cjs');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const TIMEOUT_MS = 8000;
const CACHE_MAX = 30;
const SEARCH_LIMIT = 5;

const NCM_SEARCH_URL = 'https://music.163.com/api/search/get';
const NCM_DETAIL_URL = 'https://music.163.com/api/song/detail';
const NCM_REFERER = 'https://music.163.com';
const QQ_SEARCH_URL = 'https://c.y.qq.com/soso/fcgi-bin/client_search_cp';
const QQ_REFERER = 'https://y.qq.com';
const QQ_COVER_BASE = 'https://y.qq.com/music/photo_new/T002R500x500M000';

const cache = new Map();

function log(message) {
  console.log('[SongInfo] ' + message);
}

async function request(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': UA, ...(options.headers || {}) },
      signal: controller.signal
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return options.binary ? Buffer.from(await response.arrayBuffer()) : await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 封面匹配打分（比歌词匹配更宽松）：歌名必须能互相对应，歌手/时长作为加分项。
 * 网易云搜索有时把「周杰伦」显示为「Jay」等别名，严格歌手匹配会漏掉正确封面，
 * 因此这里优先保证歌名一致 + 时长接近，歌手只用于同分时的优选。
 */
function matchScore(title, artist, duration, candTitle, candArtist, candDuration) {
  const normalizedTitle = normalizeMatchText(title);
  const normalizedCandTitle = normalizeMatchText(candTitle);
  if (normalizedTitle.length === 0 || normalizedCandTitle.length === 0) return -1;
  if (!normalizedTitle.includes(normalizedCandTitle) && !normalizedCandTitle.includes(normalizedTitle)) return -1;

  let score = 100;
  const normalizedArtist = normalizeMatchText(artist);
  const normalizedCandArtist = normalizeMatchText(candArtist);
  if (normalizedArtist.length > 0 && normalizedCandArtist.length > 0) {
    if (normalizedCandArtist.includes(normalizedArtist) || normalizedArtist.includes(normalizedCandArtist)) score += 50;
  }
  if (duration > 0 && candDuration > 0) {
    const diff = Math.abs(candDuration - duration);
    if (diff <= 2000) score += 40;
    else if (diff <= 10000) score += 20;
    else if (diff <= 30000) score += 10;
  }
  return score;
}

function pickBest(candidates) {
  let best;
  let bestScore = -1;
  for (const candidate of candidates) {
    if (candidate.score > bestScore) {
      best = candidate;
      bestScore = candidate.score;
    }
  }
  return best && bestScore >= 100 ? best : undefined;
}

function toDataUrl(buffer, contentType) {
  const mime = contentType && contentType.startsWith('image/') ? contentType : 'image/jpeg';
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

async function downloadCover(url, referer) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': UA, 'Referer': referer },
      signal: controller.signal
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const type = response.headers.get('content-type') || 'image/jpeg';
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) throw new Error('empty image');
    return toDataUrl(buffer, type);
  } finally {
    clearTimeout(timer);
  }
}

/** 网易云：搜索匹配 → /api/song/detail 拿 album.picUrl → 下载封面 */
async function fetchFromNcm(title, artist, duration) {
  try {
    const query = `${title} ${artist}`.trim();
    const url = `${NCM_SEARCH_URL}?s=${encodeURIComponent(query)}&type=1&offset=0&limit=${SEARCH_LIMIT}`;
    const search = await request(url, { headers: { Referer: NCM_REFERER } });
    const songs = search && search.result && search.result.songs;
    if (!Array.isArray(songs) || songs.length === 0) return undefined;

    const candidates = [];
    for (const song of songs) {
      const score = matchScore(title, artist, duration, song.name, joinArtistNames(song.artists), song.duration);
      if (score >= 100 && song.id !== undefined) {
        candidates.push({ score, song });
      }
    }
    const best = pickBest(candidates);
    if (!best) return undefined;
    const song = best.song;

    const detail = await request(`${NCM_DETAIL_URL}?ids=[${best.id}]`, { headers: { Referer: NCM_REFERER } });
    const picUrl = detail && detail.songs && detail.songs[0] && detail.songs[0].album && detail.songs[0].album.picUrl;
    if (!picUrl) return undefined;
    const coverBase64 = await downloadCover(picUrl, NCM_REFERER);
    return {
      coverBase64,
      duration: Number(best.duration) || 0,
      album: (detail.songs[0].album && detail.songs[0].album.name) || '',
      title: best.name,
      artist: joinArtistNames(best.artists),
      source: 'ncm'
    };
  } catch (error) {
    log('NCM cover failed: ' + error.message);
    return undefined;
  }
}

/** QQ：搜索匹配 → albummid 拼 photo_new 直链 → 下载封面 */
async function fetchFromQq(title, artist, duration) {
  try {
    const query = `${title} ${artist}`.trim();
    const url = `${QQ_SEARCH_URL}?w=${encodeURIComponent(query)}&format=json&n=${SEARCH_LIMIT}&cr=1`;
    const search = await request(url, { headers: { Referer: QQ_REFERER } });
    const list = search && search.data && search.data.song && search.data.song.list;
    if (!Array.isArray(list) || list.length === 0) return undefined;

    const candidates = [];
    for (const item of list) {
      const candDuration = item.interval > 0 ? item.interval * 1000 : 0;
      const score = matchScore(title, artist, duration, item.songname, joinArtistNames(item.singer), candDuration);
      if (score >= 100 && item.albummid) {
        candidates.push({ score, item });
      }
    }
    const best = pickBest(candidates);
    if (!best || !best.item.albummid) return undefined;
    const item = best.item;

    const coverBase64 = await downloadCover(`${QQ_COVER_BASE}${item.albummid}.jpg`, QQ_REFERER);
    return {
      coverBase64,
      duration: item.interval > 0 ? item.interval * 1000 : 0,
      album: item.albumname || '',
      title: item.songname,
      artist: joinArtistNames(item.singer),
      source: 'qq_music'
    };
  } catch (error) {
    log('QQ cover failed: ' + error.message);
    return undefined;
  }
}

function settle(promise, source) {
  return promise.then(
    value => ({ source, value }),
    () => ({ source, value: undefined })
  );
}

function firstSuccess(promises) {
  return new Promise(resolve => {
    let pending = promises.length;
    let done = false;
    for (const p of promises) {
      p.then(sr => {
        if (done) return;
        if (sr.value !== undefined) {
          done = true;
          resolve(sr.value);
        } else if (--pending === 0) {
          done = true;
          resolve(undefined);
        }
      });
    }
  });
}

function putCache(key, value) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

/**
 * 按歌名+歌手+时长联网匹配歌曲信息（封面为主，时长兜底）。
 * @returns {Promise<object|undefined>} { coverBase64, duration, album, title, artist, source }
 */
async function fetchSongInfo(title, artist, duration) {
  if (!title || title.trim().length === 0) return undefined;
  const key = `${title}\u0001${artist}`;
  if (cache.has(key)) {
    log('cache hit: ' + key);
    return cache.get(key);
  }

  const result = await firstSuccess([
    settle(fetchFromNcm(title, artist, duration), 'ncm'),
    settle(fetchFromQq(title, artist, duration), 'qq_music')
  ]);
  if (result) putCache(key, result);
  log(result ? `matched ${result.source} cover, album=${result.album}` : 'no cover matched');
  return result;
}

module.exports = { fetchSongInfo };
