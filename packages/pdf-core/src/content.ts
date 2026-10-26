/**
 * 内容流解析：把 `BT … ET` 里的显示操作还原成带位置的文本片段，
 * 同时记录每个标记内容块（MCID）里的文字。
 *
 * MCID 是结构树和内容流之间的桥：结构树说「这个段落由 MCID 17 构成」，
 * 这里就负责把 MCID 17 对应的那段字节变成字符串。
 */

import { Lexer } from './lexer.ts';
import { decodeText, textWidth, type FontInfo } from './fonts.ts';
import { PdfArray, PdfDict, PdfName, PdfString, type PdfValue } from './types.ts';

export interface TextRun {
  /** 文本起点（用户空间 x）。 */
  readonly x: number;
  /** 文本基线（用户空间 y，PDF 坐标向上为正）。 */
  readonly y: number;
  readonly size: number;
  readonly font: string;
  readonly text: string;
}

export interface ContentResult {
  readonly runs: TextRun[];
  /** MCID → 该块里的全部文字（按出现顺序拼接）。 */
  readonly mcidText: Map<number, string>;
}

type Token =
  | { kind: 'value'; value: PdfValue }
  | { kind: 'op'; op: string };

function isNumStart(c: number): boolean {
  return (
    (c >= 0x30 && c <= 0x39) || c === 0x2b || c === 0x2d || c === 0x2e
  );
}

function nextToken(lex: Lexer): Token | null {
  lex.skipWhitespace();
  const c = lex.peek();
  if (c < 0) return null;

  if (
    c === 0x2f || // /
    c === 0x28 || // (
    c === 0x3c || // <
    c === 0x5b || // [
    isNumStart(c)
  ) {
    const before = lex.pos;
    const value = lex.parseValue();
    if (lex.pos === before) {
      lex.pos++;
      return null;
    }
    return { kind: 'value', value };
  }

  const start = lex.pos;
  while (lex.pos < lex.buf.length) {
    const d = lex.buf[lex.pos] as number;
    if (d <= 0x20 || d === 0x2f || d === 0x28 || d === 0x29 || d === 0x3c || d === 0x3e || d === 0x5b || d === 0x5d) {
      break;
    }
    lex.pos++;
  }
  if (lex.pos === start) {
    lex.pos++;
    return null;
  }
  return { kind: 'op', op: Buffer.from(lex.buf.subarray(start, lex.pos)).toString('latin1') };
}

export function parseContentStream(
  buf: Uint8Array,
  resolveFont: (name: string) => FontInfo,
): ContentResult {
  const runs: TextRun[] = [];
  const mcidText = new Map<number, string>();

  const lex = new Lexer(buf);
  const operands: PdfValue[] = [];

  let fontName = '';
  let font: FontInfo = { codeWidth: 1, cmap: new Map(), subtype: '' };
  let fontSize = 12;
  let leading = 0;

  let tx = 0;
  let ty = 0;

  const mcidStack: number[] = [];

  const emit = (text: string): void => {
    if (text.length === 0) return;
    runs.push({ x: tx, y: ty, size: fontSize, font: fontName, text });
    tx += textWidth(text, fontSize);

    const current = mcidStack[mcidStack.length - 1];
    if (current !== undefined && current >= 0) {
      mcidText.set(current, (mcidText.get(current) ?? '') + text);
    }
  };

  const showString = (value: PdfValue | undefined): void => {
    if (value instanceof PdfString) emit(decodeText(value.bytes, font));
  };

  const showArray = (value: PdfValue | undefined): void => {
    if (!(value instanceof PdfArray)) return;
    for (const item of value.items) {
      if (item instanceof PdfString) emit(decodeText(item.bytes, font));
      else if (typeof item === 'number') {
        // TJ 里的负数表示加宽字距（右移）
        tx += (-item / 1000) * fontSize;
      }
    }
  };

  const numOperand = (i: number): number | undefined => {
    const v = operands[i];
    return typeof v === 'number' ? v : undefined;
  };

  for (;;) {
    const token = nextToken(lex);
    if (!token) break;

    if (token.kind === 'value') {
      operands.push(token.value);
      continue;
    }

    switch (token.op) {
      case 'Tf': {
        const name = operands[0];
        if (name instanceof PdfName) {
          fontName = name.value;
          font = resolveFont(fontName);
        }
        const size = numOperand(1);
        if (size !== undefined && size !== 0) fontSize = Math.abs(size);
        break;
      }
      case 'Tm': {
        const e = numOperand(4);
        const f = numOperand(5);
        if (e !== undefined && f !== undefined) {
          tx = e;
          ty = f;
        }
        break;
      }
      case 'Td': {
        const dx = numOperand(0);
        const dy = numOperand(1);
        if (dx !== undefined) tx += dx;
        if (dy !== undefined) ty += dy;
        break;
      }
      case 'TD': {
        const dx = numOperand(0);
        const dy = numOperand(1);
        if (dx !== undefined) tx += dx;
        if (dy !== undefined) {
          ty += dy;
          leading = -dy;
        }
        break;
      }
      case 'T*':
        ty -= leading;
        break;
      case 'TL': {
        const l = numOperand(0);
        if (l !== undefined) leading = l;
        break;
      }
      case 'BT':
        tx = 0;
        ty = 0;
        break;
      case 'Tj':
        showString(operands[0]);
        break;
      case 'TJ':
        showArray(operands[0]);
        break;
      case "'":
        ty -= leading;
        showString(operands[0]);
        break;
      case '"':
        ty -= leading;
        showString(operands[2]);
        break;
      case 'BDC': {
        // `BDC` 的操作数是「标签名 + 属性」两个，属性在第 2 个操作数上，
        // 但也见过只写一个的，所以整体扫一遍找带 /MCID 的字典。
        let mcid = -1;
        for (const op of operands) {
          if (op instanceof PdfDict) {
            const value = op.num('MCID');
            if (typeof value === 'number') {
              mcid = value;
              break;
            }
          }
        }
        mcidStack.push(mcid);
        break;
      }
      case 'BMC':
        mcidStack.push(-1);
        break;
      case 'EMC':
        mcidStack.pop();
        break;
      case 'BI': {
        // 内联图像：跳到 EI
        const idx = indexOfKeyword(buf, 'EI', lex.pos);
        lex.pos = idx >= 0 ? idx + 2 : buf.length;
        break;
      }
      default:
        break;
    }

    operands.length = 0;
  }

  return { runs, mcidText };
}

function indexOfKeyword(buf: Uint8Array, word: string, from: number): number {
  const needle = Buffer.from(word, 'latin1');
  let idx = Buffer.from(buf).indexOf(needle, from);
  while (idx >= 0) {
    const before = idx === 0 ? 0x20 : (buf[idx - 1] as number);
    const after = buf[idx + word.length];
    const okBefore = before <= 0x20;
    const okAfter = after === undefined || after <= 0x20;
    if (okBefore && okAfter) return idx;
    idx = Buffer.from(buf).indexOf(needle, idx + 1);
  }
  return -1;
}
