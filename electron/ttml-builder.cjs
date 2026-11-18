/**
 * AMLL TTML 歌词构建器 —— 从鸿蒙项目 AmllTtmlBuilder.ets 逐条移植。
 *
 * 把网易云 LRC / YRC 原文与对应翻译（tlyric / ytlrc，均为 LRC 时间戳格式）
 * 合并为 Web 端 @applemusic-like-lyrics/ttml 解析器可直接解析的 TTML 文本：
 * - 行级：LRC + tlyric → <p begin end> 整行文本 + 内联 <span ttm:role="x-translation">
 * - 逐字：YRC + ytlrc → <p> 内逐字 <span begin end> + 内联翻译 span
 * 翻译匹配规则：时间戳精确相等优先，其次 |Δ| ≤ 1s 内取最近邻。
 *
 * 这是「翻译按钮经常检测不到」的根因修复：只有把翻译写进 TTML 的 x-translation，
 * Web 侧 parseTTML 才会产出 translatedLyric，hasTranslation 才会为 true。
 */
'use strict';

const TRANSLATION_TOLERANCE_MS = 1000;
const META_LINE_REGEX = /^(作词|作曲|制作人|编曲)\s*[:：]/;
const LRC_TIME_REGEX = /^\[((?:\d+:)*\d+(?:\.\d+)?)\]/;
const LRC_TAG_REGEX = /^\[[a-z]+:[^\]]+\]$/i;
const YRC_LINE_HEAD_REGEX = /^\[(\d+),(\d+)\]/;
// 词时间戳在前、词文本在后：如 (17534,381,0)Saw。用懒匹配 + 允许空文本。
const YRC_WORD_REGEX = /^([\s\S]*?)\((\d+),(\d+),\d+\)/;
const LAST_LINE_DURATION_MS = 60000;

function parseLrcTimeToMs(time) {
  const parts = String(time).split(':');
  let totalMs = 0;
  for (const part of parts) {
    const value = Number(part);
    if (!Number.isFinite(value)) return NaN;
    totalMs = totalMs * 60 + value;
  }
  return Math.round(totalMs * 1000);
}

function parseLrc(text) {
  const result = [];
  if (!text || text.length === 0) return result;
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (line.length === 0 || LRC_TAG_REGEX.test(line)) continue;
    const times = [];
    for (;;) {
      const match = LRC_TIME_REGEX.exec(line);
      if (match === null) break;
      const timeMs = parseLrcTimeToMs(match[1]);
      if (!Number.isFinite(timeMs)) break;
      times.push(timeMs);
      line = line.slice(match[0].length);
    }
    if (times.length === 0) continue;
    const textPart = line.trim();
    if (textPart.length === 0) continue;
    for (const timeMs of times) result.push({ timeMs, text: textPart });
  }
  result.sort((a, b) => a.timeMs - b.timeMs);
  return result;
}

function parseYrc(text) {
  const result = [];
  if (!text || text.length === 0) return result;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const head = YRC_LINE_HEAD_REGEX.exec(line);
    if (head === null) continue;
    const startMs = Number(head[1]);
    const endMs = startMs + Number(head[2]);
    if (!Number.isFinite(startMs)) continue;
    let rest = line.slice(head[0].length).trim();
    const words = [];
    let pendingStart = -1;
    let pendingEnd = -1;
    for (;;) {
      const match = YRC_WORD_REGEX.exec(rest);
      if (match === null) break;
      const wordText = match[1];
      if (wordText.length > 0 && pendingStart !== -1) {
        words.push({ word: wordText, startMs: pendingStart, endMs: pendingEnd });
      }
      pendingStart = Number(match[2]);
      pendingEnd = pendingStart + Number(match[3]);
      rest = rest.slice(match[0].length);
    }
    if (pendingStart !== -1 && rest.length > 0) {
      words.push({ word: rest, startMs: pendingStart, endMs: pendingEnd });
    }
    if (words.length === 0) continue;
    // 词尾空格是英文单词分隔符，保留；首尾成对括号剥离
    const first = words[0].word;
    const last = words[words.length - 1].word;
    const wrapped = first.length > 0 && last.length > 0 && /^[（(]/.test(first) && /[）)]\s*$/.test(last);
    if (wrapped) {
      words[0].word = words[0].word.slice(1);
      words[words.length - 1].word = words[words.length - 1].word.replace(/[）)](\s*)$/, '$1');
    }
    result.push({ startMs, endMs, words });
  }
  return result;
}

function matchTranslation(translations, timeMs) {
  if (translations.length === 0) return '';
  let bestIndex = -1;
  let bestDelta = Number.MAX_VALUE;
  for (let i = 0; i < translations.length; i++) {
    const delta = Math.abs(translations[i].timeMs - timeMs);
    if (delta === 0) return translations[i].text;
    if (delta <= TRANSLATION_TOLERANCE_MS && delta < bestDelta) {
      bestDelta = delta;
      bestIndex = i;
    }
  }
  return bestIndex >= 0 ? translations[bestIndex].text : '';
}

function escapeXml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function formatTime(ms) {
  const safeMs = Math.max(0, Math.round(ms));
  const minutes = Math.floor(safeMs / 60000);
  const seconds = Math.floor(safeMs / 1000) % 60;
  const millis = safeMs % 1000;
  const ss = seconds < 10 ? `0${seconds}` : `${seconds}`;
  const mmm = millis < 10 ? `00${millis}` : (millis < 100 ? `0${millis}` : `${millis}`);
  return `${minutes}:${ss}.${mmm}`;
}

function buildLineTag(beginMs, endMs, index, inner, translation) {
  let tag = `<p begin="${formatTime(beginMs)}" end="${formatTime(endMs)}" itunes:key="L${index}" ttm:agent="v1">${inner}`;
  if (translation.length > 0) {
    tag += `<span ttm:role="x-translation">${escapeXml(translation)}</span>`;
  }
  return tag + '</p>';
}

function wrapTtml(lineTags, timing) {
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<tt xmlns="http://www.w3.org/ns/ttml" ' +
    'xmlns:ttm="http://www.w3.org/ns/ttml#metadata" ' +
    'xmlns:itunes="http://music.apple.com/lyric-ttml-internal" ' +
    'xml:space="preserve" ' +
    `itunes:timing="${timing}">` +
    '<body><div>' + lineTags.join('') + '</div></body>' +
    '</tt>';
}

/** LRC + tlyric → 行级 TTML（含翻译）；无有效行返回空串 */
function buildFromLrc(lrcText, translationText) {
  const lines = parseLrc(lrcText).filter(l => !META_LINE_REGEX.test(l.text));
  if (lines.length === 0) return '';
  const translations = parseLrc(translationText || '');
  const parts = [];
  for (let i = 0; i < lines.length; i++) {
    const beginMs = lines[i].timeMs;
    const endMs = i + 1 < lines.length ? lines[i + 1].timeMs : beginMs + LAST_LINE_DURATION_MS;
    const translation = matchTranslation(translations, beginMs);
    parts.push(buildLineTag(beginMs, Math.max(endMs, beginMs), i + 1, escapeXml(lines[i].text), translation));
  }
  return wrapTtml(parts, 'Line');
}

/** YRC + ytlrc → 逐字 TTML（含翻译）；无有效行返回空串 */
function buildFromYrc(yrcText, translationText) {
  const lines = parseYrc(yrcText).filter(line => {
    const joined = line.words.map(w => w.word).join('').trim();
    return !META_LINE_REGEX.test(joined);
  });
  if (lines.length === 0) return '';
  const translations = parseLrc(translationText || '');
  const parts = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const translation = matchTranslation(translations, line.startMs);
    const wordTags = line.words.map(w =>
      `<span begin="${formatTime(w.startMs)}" end="${formatTime(w.endMs)}">${escapeXml(w.word)}</span>`);
    parts.push(buildLineTag(line.startMs, Math.max(line.endMs, line.startMs), i + 1, wordTags.join(''), translation));
  }
  return wrapTtml(parts, 'Word');
}

module.exports = { buildFromLrc, buildFromYrc };
