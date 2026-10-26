/**
 * PDF 对象表：暴力扫描 `N G obj`、展开对象流（ObjStm）、解码流。
 *
 * 为什么不用 xref 表：交叉引用表 + xref 流的正确解析需要处理增量更新、
 * 混合引用、错误偏移等一堆边界情况，而模组文件通常只有几百 KB 到几 MB。
 * 线性扫描一遍更简单也更皮实——这是 Python 原型验证过的做法。
 */

import { inflateRawSync, inflateSync } from 'node:zlib';

import { Lexer, parseValueAt } from './lexer.ts';
import {
  PdfArray,
  PdfDict,
  type PdfRef,
  type PdfStream,
  type PdfValue,
  isStream,
} from './types.ts';

const OBJ_HEADER = /(\d+)\s+(\d+)\s+obj\b/g;

export interface PageEntry {
  readonly objNum: number;
  readonly dict: PdfDict;
  /** 已合并的内容流字节（未解码）。 */
  readonly contents: Uint8Array;
  /** 页面资源字典（含 `/Font`），已沿页树继承寻找。 */
  readonly resources?: PdfDict;
}

export class PdfObjects {
  readonly buf: Uint8Array;
  readonly map = new Map<number, PdfValue>();

  constructor(buf: Uint8Array) {
    this.buf = buf;
    this.scan();
    this.expandObjectStreams();
  }

  /** 解引用；引用链只解一层（PDF 不允许链式引用，但防御一下）。 */
  resolve(value: PdfValue | undefined): PdfValue | undefined {
    let v = value;
    for (let i = 0; i < 8; i++) {
      if (v === undefined || v === null) return v;
      if (typeof v === 'object' && 'num' in v && 'gen' in v && !(v instanceof PdfDict)) {
        v = this.map.get((v as PdfRef).num);
        continue;
      }
      break;
    }
    return v;
  }

  dictOf(value: PdfValue | undefined): PdfDict | undefined {
    const v = this.resolve(value);
    if (v instanceof PdfDict) return v;
    if (isStream(v)) return v.dict;
    return undefined;
  }

  streamOf(value: PdfValue | undefined): PdfStream | undefined {
    const v = this.resolve(value);
    return isStream(v) ? v : undefined;
  }

  arrayOf(value: PdfValue | undefined): PdfValue[] | undefined {
    const v = this.resolve(value);
    if (v instanceof PdfArray) return v.items;
    if (Array.isArray(v)) return v;
    return undefined;
  }

  private scan(): void {
    // latin1 保持字节一一对应，避免 UTF-8 解码破坏二进制
    const text = Buffer.from(this.buf).toString('latin1');
    OBJ_HEADER.lastIndex = 0;

    let m: RegExpExecArray | null;
    while ((m = OBJ_HEADER.exec(text)) !== null) {
      const num = Number.parseInt(m[1] as string, 10);
      const bodyStart = m.index + m[0].length;

      const lexer = new Lexer(this.buf, bodyStart);
      const value = lexer.parseValue();

      // 解析不出东西就是误命中（例如流数据里恰好出现 "12 0 obj"）
      if (value === null && lexer.pos === bodyStart) continue;

      let stored: PdfValue = value;

      if (value instanceof PdfDict) {
        const save = lexer.pos;
        lexer.skipWhitespace();
        if (this.matchesKeyword(lexer.pos, 'stream')) {
          const afterStream = lexer.pos + 'stream'.length;
          stored = this.readStream(afterStream, value);
        } else {
          lexer.pos = save;
        }
      }

      this.map.set(num, stored);
    }
  }

  private matchesKeyword(pos: number, word: string): boolean {
    for (let i = 0; i < word.length; i++) {
      if (this.buf[pos + i] !== word.charCodeAt(i)) return false;
    }
    const after = this.buf[pos + word.length];
    return after === undefined || after <= 0x20 || after === 0x2f || after === 0x3e;
  }

  private indexOfKeyword(word: string, from: number): number {
    const needle = Buffer.from(word, 'latin1');
    return Buffer.from(this.buf).indexOf(needle, from);
  }

  private readStream(afterStreamKw: number, dict: PdfDict): PdfStream {
    let p = afterStreamKw;
    // 紧跟 stream 的必须是 EOL（CRLF 或 LF）
    if (this.buf[p] === 0x0d) p++;
    if (this.buf[p] === 0x0a) p++;

    const declared = dict.num('Length');
    let end = -1;
    let truncated = false;

    if (typeof declared === 'number' && declared >= 0 && p + declared <= this.buf.length) {
      const candidate = p + declared;
      // 校验：跳过空白后应能看到 endstream
      let probe = candidate;
      while (probe < this.buf.length && (this.buf[probe] as number) <= 0x20) probe++;
      if (this.matchesKeyword(probe, 'endstream')) {
        end = candidate;
      }
    }

    if (end < 0) {
      const found = this.indexOfKeyword('endstream', p);
      end = found >= 0 ? found : this.buf.length;
      truncated = true;
      // 去掉 endstream 前的 EOL
      while (end > p && ((this.buf[end - 1] as number) === 0x0a || (this.buf[end - 1] as number) === 0x0d)) {
        end--;
      }
    }

    return { dict, raw: this.buf.subarray(p, end), truncated };
  }

  /** 展开 `/Type /ObjStm` 里的对象；已存在的编号不覆盖（外部定义优先）。 */
  private expandObjectStreams(): void {
    const streams: PdfStream[] = [];
    for (const value of this.map.values()) {
      if (isStream(value) && value.dict.name('Type') === 'ObjStm') streams.push(value);
    }

    for (const stream of streams) {
      let data: Uint8Array;
      try {
        data = decodeStream(stream);
      } catch {
        continue;
      }

      const count = stream.dict.num('N') ?? 0;
      const first = stream.dict.num('First') ?? 0;
      if (count <= 0 || first <= 0 || first > data.length) continue;

      const header = new Lexer(data.subarray(0, first), 0);
      const nums: number[] = [];
      const offsets: number[] = [];

      for (let i = 0; i < count * 2; i++) {
        header.skipWhitespace();
        if (header.eof) break;
        const n = header.readInteger();
        if (i % 2 === 0) nums.push(n);
        else offsets.push(n);
      }

      for (let i = 0; i < nums.length; i++) {
        const num = nums[i] as number;
        const offset = offsets[i];
        if (offset === undefined) continue;

        const start = first + offset;
        if (start >= data.length) continue;
        const nextOffset = offsets[i + 1];
        const end =
          nextOffset !== undefined
            ? Math.min(data.length, first + nextOffset)
            : data.length;

        const { value } = parseValueAt(data, start);
        if (value === null && start === end) continue;
        if (!this.map.has(num)) this.map.set(num, value);
        void end;
      }
    }
  }

  /** 找 `/Type /Catalog` 的对象。 */
  catalog(): { num: number; dict: PdfDict } | undefined {
    for (const [num, value] of this.map) {
      if (value instanceof PdfDict && value.name('Type') === 'Catalog') {
        return { num, dict: value };
      }
    }
    return undefined;
  }

  /** 按 `/Pages` → `/Kids` 的声明顺序展开页对象（不是按对象号排序）。 */
  pages(): PageEntry[] {
    const cat = this.catalog();
    if (!cat) return [];

    const rootRef = cat.dict.get('Pages');
    const out: PageEntry[] = [];
    const seen = new Set<number>();

    const walk = (node: PdfValue | undefined, inherited: PdfDict | undefined, depth: number): void => {
      if (depth > 64) return;
      const dict = this.dictOf(node);
      if (!dict) return;

      const objNum = this.objNumOf(node);
      if (objNum !== undefined) {
        if (seen.has(objNum)) return;
        seen.add(objNum);
      }

      const type = dict.name('Type');
      // /Resources 常常是引用，必须解引用后再往下传，否则字体全丢
      const resources = this.dictOf(dict.get('Resources')) ?? inherited;

      if (type === 'Pages' || dict.has('Kids')) {
        const kids = this.arrayOf(dict.get('Kids'));
        if (kids) for (const kid of kids) walk(kid, resources, depth + 1);
        return;
      }

      if (type === 'Page') {
        const contents = this.collectContents(dict.get('Contents'));
        out.push({
          objNum: objNum ?? -1,
          dict,
          contents,
          resources,
        });
      }
    };

    walk(rootRef, this.dictOf(cat.dict.get('Resources')), 0);
    return out;
  }

  objNumOf(value: PdfValue | undefined): number | undefined {
    if (value !== undefined && value !== null && typeof value === 'object') {
      if ('num' in value && 'gen' in value && !(value instanceof PdfDict)) {
        return (value as PdfRef).num;
      }
    }
    return undefined;
  }

  private collectContents(value: PdfValue | undefined): Uint8Array {
    const parts: Uint8Array[] = [];
    const single = this.streamOf(value);
    // 内容流几乎总是 FlateDecode 压缩的，必须解压后再交给词法解析
    if (single) return decodeStream(single);

    const arr = this.arrayOf(value);
    if (arr) {
      for (const item of arr) {
        const s = this.streamOf(item);
        if (s) parts.push(decodeStream(s));
      }
    }

    if (parts.length === 0) return new Uint8Array(0);
    if (parts.length === 1) return parts[0] as Uint8Array;

    let total = 0;
    for (const p of parts) total += p.length;
    const merged = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      merged.set(p, off);
      off += p.length;
    }
    return merged;
  }
}

/** 解压流的原始字节（目前只处理 FlateDecode / ASCIIHexDecode）。 */
export function decodeStream(stream: PdfStream): Uint8Array {
  const filters = filterNames(stream.dict);
  let data = stream.raw;

  for (const f of filters) {
    if (f === 'FlateDecode' || f === 'Fl') {
      data = inflate(data);
    } else if (f === 'ASCIIHexDecode' || f === 'AHx') {
      data = asciiHexDecode(data);
    } else {
      // 图像等二进制编码：保持原始字节
      break;
    }
  }

  const parms = decodeParms(stream.dict);
  const predictor = parms?.num('Predictor');
  if (typeof predictor === 'number' && predictor > 1) {
    data = applyPredictor(data, parms!);
  }

  return data;
}

function filterNames(dict: PdfDict): string[] {
  const f = dict.get('Filter');
  if (f === undefined) return [];
  const one = f as { value?: string };
  if (typeof one === 'object' && one !== null && typeof one.value === 'string') {
    return [one.value];
  }
  if (f instanceof PdfArray) {
    return f.items
      .map((v) => (v as { value?: string }).value)
      .filter((v): v is string => typeof v === 'string');
  }
  return [];
}

function decodeParms(dict: PdfDict): PdfDict | undefined {
  const p = dict.get('DecodeParms') ?? dict.get('DP');
  if (p instanceof PdfDict) return p;
  if (p instanceof PdfArray && p.items.length > 0) {
    const first = p.items[0];
    if (first instanceof PdfDict) return first;
  }
  return undefined;
}

function inflate(data: Uint8Array): Uint8Array {
  try {
    return new Uint8Array(inflateSync(data));
  } catch {
    try {
      return new Uint8Array(inflateRawSync(data));
    } catch {
      return data;
    }
  }
}

function asciiHexDecode(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let high = -1;
  for (const c of data) {
    if (c === 0x3e) break; // '>'
    let v = -1;
    if (c >= 0x30 && c <= 0x39) v = c - 0x30;
    else if (c >= 0x41 && c <= 0x46) v = c - 0x41 + 10;
    else if (c >= 0x61 && c <= 0x66) v = c - 0x61 + 10;
    if (v < 0) continue;
    if (high < 0) high = v;
    else {
      out.push(high * 16 + v);
      high = -1;
    }
  }
  if (high >= 0) out.push(high * 16);
  return new Uint8Array(out);
}

/** PNG / TIFF 预测器（xref 流常见，页内容流少见，但便宜就一起做了）。 */
function applyPredictor(data: Uint8Array, parms: PdfDict): Uint8Array {
  const predictor = parms.num('Predictor') ?? 1;
  const colors = parms.num('Colors') ?? 1;
  const bits = parms.num('BitsPerComponent') ?? 8;
  const columns = parms.num('Columns') ?? 1;

  const bpp = Math.max(1, Math.ceil((colors * bits) / 8));
  const rowLen = Math.ceil((colors * bits * columns) / 8);

  if (predictor === 2) {
    // TIFF predictor（只支持 8 位）
    if (bits !== 8) return data;
    const out = new Uint8Array(data);
    for (let row = 0; row + rowLen <= out.length; row += rowLen) {
      for (let i = bpp; i < rowLen; i++) {
        out[row + i] = ((out[row + i] as number) + (out[row + i - bpp] as number)) & 0xff;
      }
    }
    return out;
  }

  // PNG predictor：每行前有 1 字节 filter type
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = new Uint8Array(rows * rowLen);
  let prev = new Uint8Array(rowLen);

  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowLen + 1)] as number;
    const src = data.subarray(r * (rowLen + 1) + 1, r * (rowLen + 1) + 1 + rowLen);
    const cur = new Uint8Array(rowLen);

    for (let i = 0; i < rowLen; i++) {
      const raw = src[i] ?? 0;
      const left = i >= bpp ? (cur[i - bpp] as number) : 0;
      const up = prev[i] as number;
      const upLeft = i >= bpp ? (prev[i - bpp] as number) : 0;

      switch (type) {
        case 0:
          cur[i] = raw;
          break;
        case 1:
          cur[i] = (raw + left) & 0xff;
          break;
        case 2:
          cur[i] = (raw + up) & 0xff;
          break;
        case 3:
          cur[i] = (raw + ((left + up) >> 1)) & 0xff;
          break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          const pred = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          cur[i] = (raw + pred) & 0xff;
          break;
        }
        default:
          cur[i] = raw;
      }
    }

    out.set(cur, r * rowLen);
    prev = cur;
  }

  return out;
}
