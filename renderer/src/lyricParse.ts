/**
 * 歌词解析模块。
 * 使用 AMLL 官方解析器（@applemusic-like-lyrics/lyric + @applemusic-like-lyrics/ttml）
 * 将原始歌词文本转换为 LyricPlayer 可直接使用的 LyricLine[]。
 *
 * - TTML：parseTTML（@applemusic-like-lyrics/ttml）直接产出 AmllLyricResult，
 *   其 lines 与 LyricLine 结构完全兼容（words/translatedLyric/romanLyric/isBG/isDuet/startTime/endTime）。
 * - LRC：parseLrc（@applemusic-like-lyrics/lyric）已产出完整 LyricLine[]，
 *   endTime 自动取下一行 startTime、末行取极大值，无需手工转换。
 * - QRC/YRC：parseQrc/parseYrc。
 * 所有解析均 try-catch 容错，非法输入返回空数组。
 */
import { parseLrc, parseQrc, parseYrc } from '@applemusic-like-lyrics/lyric';
import { parseTTML } from '@applemusic-like-lyrics/ttml';
import type { LyricLine } from '@applemusic-like-lyrics/core';

/** 歌词格式（与原生侧 LyricFormat 枚举对齐） */
export type LyricFormat = 'TTML' | 'LRC' | 'QRC' | 'YRC';

/** QRC 行前缀特征：`[起始,时长]`（用于与 LRC 内容自动识别） */
const QRC_LINE_PREFIX = /^\[\d+,\d+\]/;

function parseTtmlLines(rawText: string): LyricLine[] {
  const result = parseTTML(rawText);
  return result.lines as LyricLine[];
}

function parseLrcLines(rawText: string): LyricLine[] {
  return parseLrc(rawText);
}

function parseQrcLines(rawText: string): LyricLine[] {
  const trimmed = rawText.trim();
  if (QRC_LINE_PREFIX.test(trimmed)) {
    return parseQrc(rawText);
  }
  // QQ 接口实测返回 base64 编码的 LRC 而非 QRC：解码后内容不符合 QRC 特征时回退 LRC
  return parseLrc(rawText);
}

function parseYrcLines(rawText: string): LyricLine[] {
  return parseYrc(rawText);
}

/**
 * 按格式解析歌词。
 * @param rawText 歌词原始文本
 * @param format 歌词格式
 * @returns 解析后的 LyricLine[]（失败返回空数组）
 */
export function parseLyric(rawText: string, format: LyricFormat): LyricLine[] {
  try {
    if (!rawText || rawText.trim().length === 0) {
      return [];
    }
    switch (format) {
      case 'TTML':
        return parseTtmlLines(rawText);
      case 'LRC':
        return parseLrcLines(rawText);
      case 'QRC':
        return parseQrcLines(rawText);
      case 'YRC':
        return parseYrcLines(rawText);
      default:
        return [];
    }
  } catch (err) {
    console.error('[AMLyrics] parseLyric failed for format', format, err);
    return [];
  }
}
