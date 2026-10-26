/**
 * 字体与 ToUnicode CMap。
 *
 * 中文 PDF 几乎都是用 CID 字体 + `/Identity-H` 编码，字节本身没有含义，
 * 必须靠 `/ToUnicode` 映射表还原成字符。没有这张表就只能拿到乱码或空白，
 * 所以它是「能不能读」的分水岭。
 *
 * 两个容易踩的坑（Python 原型上真实踩过）：
 * 1. `beginbfrange` 有两种写法：`<lo> <hi> <dst>` 与 `<lo> <hi> [<d1> <d2> …]`，
 *    只实现前者会让整页中文变成 `�`；
 * 2. `dst` 可能是多个 UTF-16 码元（比如连字），要整体解码而不是取第一个字节。
 */

import { decodeStream, type PdfObjects } from './objects.ts';
import { PdfArray, PdfDict, type PdfStream } from './types.ts';

export interface FontInfo {
  /** 每个 code 占几个字节：复合字体（Type0）是 2，简单字体是 1。 */
  readonly codeWidth: 1 | 2;
  /** code → 文本 */
  readonly cmap: Map<number, string>;
  readonly subtype: string;
}

const EMPTY: FontInfo = { codeWidth: 1, cmap: new Map(), subtype: '' };

export function buildFontInfo(objs: PdfObjects, dict: PdfDict | undefined): FontInfo {
  if (!dict) return EMPTY;

  const subtype = dict.name('Subtype') ?? '';
  const isComposite = subtype === 'Type0' || dict.has('DescendantFonts');
  const codeWidth: 1 | 2 = isComposite ? 2 : 1;

  const cmap = new Map<number, string>();
  const toUnicode = objs.streamOf(dict.get('ToUnicode'));
  if (toUnicode) {
    let bytes: Uint8Array;
    try {
      bytes = decodeStream(toUnicode);
    } catch {
      bytes = toUnicode.raw;
    }
    parseToUnicode(bytes, cmap);
  }

  return { codeWidth, cmap, subtype };
}

/** 解析 ToUnicode CMap 文本，填充 `code → string`。 */
export function parseToUnicode(data: Uint8Array, out: Map<number, string>): void {
  const text = Buffer.from(data).toString('latin1');

  // ---- beginbfchar：一对一的直接映射 ----
  for (const m of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    const block = m[1] ?? '';
    const re = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g;
    let pair: RegExpExecArray | null;
    while ((pair = re.exec(block)) !== null) {
      const src = Number.parseInt(pair[1] as string, 16);
      const dst = hexToText(pair[2] as string);
      if (dst.length > 0) out.set(src, dst);
    }
  }

  // ---- beginbfrange：区间映射，dst 可能是单值也可能是数组 ----
  for (const m of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const block = m[1] ?? '';
    const re =
      /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]+)>|\[([\s\S]*?)\])/g;
    let range: RegExpExecArray | null;

    while ((range = re.exec(block)) !== null) {
      const lo = Number.parseInt(range[1] as string, 16);
      const hi = Number.parseInt(range[2] as string, 16);
      if (hi < lo) continue;

      const single = range[3];
      const list = range[4];

      if (single !== undefined) {
        // 线性：dst 是起始码点，逐项 +i
        const base = hexToBytes(single);
        const count = Math.min(hi - lo + 1, 65536);
        for (let i = 0; i < count; i++) {
          out.set(lo + i, bytesToText(increment(base, i)));
        }
      } else if (list !== undefined) {
        // 数组：逐个对应
        const items = [...list.matchAll(/<([0-9a-fA-F]+)>/g)].map((x) => x[1] as string);
        for (let i = 0; i < items.length && lo + i <= hi; i++) {
          out.set(lo + i, hexToText(items[i] as string));
        }
      }
    }
  }
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.length % 2 === 1 ? `0${hex}` : hex;
  return new Uint8Array(Buffer.from(clean, 'hex'));
}

function hexToText(hex: string): string {
  return bytesToText(hexToBytes(hex));
}

function bytesToText(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';
  if (bytes.length === 1) return String.fromCharCode(bytes[0] as number);
  // 多字节一律按 UTF-16BE 处理（PDF 的 ToUnicode 就是这么定的）
  let out = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    out += String.fromCharCode(((bytes[i] as number) << 8) | (bytes[i + 1] as number));
  }
  if (bytes.length % 2 === 1) out += String.fromCharCode(bytes[bytes.length - 1] as number);
  return out;
}

/** 把 UTF-16BE 编码的字节串当整数加 `delta`（用于线性 bfrange）。 */
function increment(bytes: Uint8Array, delta: number): Uint8Array {
  if (bytes.length === 1) {
    return new Uint8Array([((bytes[0] as number) + delta) & 0xff]);
  }
  const n = ((bytes[0] as number) << 8) | (bytes[1] as number);
  const v = (n + delta) & 0xffff;
  return new Uint8Array([v >> 8, v & 0xff]);
}

/** 用字体的 CMap 解码一段显示文本。 */
export function decodeText(bytes: Uint8Array, font: FontInfo): string {
  if (font.codeWidth === 2) {
    let s = '';
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const code = ((bytes[i] as number) << 8) | (bytes[i + 1] as number);
      s += font.cmap.get(code) ?? '';
    }
    return s;
  }

  let s = '';
  for (const b of bytes) {
    s += font.cmap.get(b) ?? String.fromCharCode(b);
  }
  return s;
}

/** 估算一行文字的宽度（pt）。ASCII 按 0.5em，其它按 1em。 */
export function textWidth(text: string, size: number): number {
  let w = 0;
  for (const ch of text) {
    w += size * (ch.codePointAt(0)! < 128 ? 0.5 : 1.0);
  }
  return w;
}

/** 从页资源的 `/Font` 里取字体（`Font` 的值可能直接是字典，也可能是引用）。 */
export function fontFor(
  objs: PdfObjects,
  resources: PdfDict | undefined,
  name: string,
): FontInfo {
  const fonts = resources ? objs.dictOf(resources.get('Font')) : undefined;
  if (!fonts) return EMPTY;
  const entry = fonts.get(name);
  const dict = objs.dictOf(entry);
  return buildFontInfo(objs, dict);
}

export type { PdfStream, PdfArray };
