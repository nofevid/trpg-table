/**
 * PDF 词法/语法解析：把一个字节流里的值解析成 `PdfValue`。
 *
 * PDF 的语法小到可以一个类写完，但要小心三件事：
 * 1. `N G R` 是引用，靠「整数 + 整数 + R」前瞻判定；
 * 2. 字面量字符串支持嵌套括号与八进制转义；
 * 3. 注释 `%` 到行尾，要跳过。
 */

import {
  PdfArray,
  PdfDict,
  PdfName,
  PdfRef,
  PdfString,
  type PdfValue,
} from './types.ts';

const CH_NUL = 0x00;
const CH_TAB = 0x09;
const CH_LF = 0x0a;
const CH_FF = 0x0c;
const CH_CR = 0x0d;
const CH_SPACE = 0x20;
const CH_LPAREN = 0x28;
const CH_RPAREN = 0x29;
const CH_LT = 0x3c;
const CH_GT = 0x3e;
const CH_LBRACKET = 0x5b;
const CH_RBRACKET = 0x5d;
const CH_SLASH = 0x2f;
const CH_PERCENT = 0x25;
const CH_BACKSLASH = 0x5c;
const CH_R = 0x52;
const CH_HASH = 0x23;

function isWhitespace(c: number): boolean {
  return (
    c === CH_NUL ||
    c === CH_TAB ||
    c === CH_LF ||
    c === CH_FF ||
    c === CH_CR ||
    c === CH_SPACE
  );
}

function isDelimiter(c: number): boolean {
  return (
    c === CH_LPAREN ||
    c === CH_RPAREN ||
    c === CH_LT ||
    c === CH_GT ||
    c === CH_LBRACKET ||
    c === CH_RBRACKET ||
    c === 0x7b || // {
    c === 0x7d || // }
    c === CH_SLASH ||
    c === CH_PERCENT
  );
}

function isDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x39;
}

function hexValue(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;
  if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10;
  return -1;
}

export class Lexer {
  readonly buf: Uint8Array;
  pos: number;

  constructor(buf: Uint8Array, pos: number = 0) {
    this.buf = buf;
    this.pos = pos;
  }

  get eof(): boolean {
    return this.pos >= this.buf.length;
  }

  peek(offset: number = 0): number {
    const i = this.pos + offset;
    return i < this.buf.length ? (this.buf[i] as number) : -1;
  }

  /** 跳过空白与 `%` 注释。 */
  skipWhitespace(): void {
    while (this.pos < this.buf.length) {
      const c = this.buf[this.pos] as number;
      if (isWhitespace(c)) {
        this.pos++;
      } else if (c === CH_PERCENT) {
        while (this.pos < this.buf.length) {
          const d = this.buf[this.pos] as number;
          this.pos++;
          if (d === CH_LF || d === CH_CR) break;
        }
      } else {
        break;
      }
    }
  }

  /** 解析一个值。遇到无法识别的内容时消费一个字节并返回 `null`。 */
  parseValue(): PdfValue {
    this.skipWhitespace();
    const c = this.peek();
    if (c < 0) return null;

    if (c === CH_SLASH) return this.parseName();
    if (c === CH_LPAREN) return this.parseLiteralString();
    if (c === CH_LT) {
      if (this.peek(1) === CH_LT) return this.parseDict();
      return this.parseHexString();
    }
    if (c === CH_LBRACKET) return this.parseArray();
    if (c === 0x74 || c === 0x66 || c === 0x6e) {
      // t / f / n：可能是 true / false / null
      const word = this.peekWord();
      if (word === 'true') {
        this.pos += 4;
        return true;
      }
      if (word === 'false') {
        this.pos += 5;
        return false;
      }
      if (word === 'null') {
        this.pos += 4;
        return null;
      }
      // 否则当作普通关键字，消费掉
      this.pos += Math.max(1, word.length);
      return null;
    }
    if (
      isDigit(c) ||
      c === 0x2b || // +
      c === 0x2d || // -
      c === 0x2e // .
    ) {
      return this.parseNumberOrRef();
    }

    // 兜底：消费一个字节，避免死循环
    this.pos++;
    return null;
  }

  /** 读取当前位置的字母序列（不移动位置）。 */
  peekWord(): string {
    let i = this.pos;
    while (i < this.buf.length) {
      const c = this.buf[i] as number;
      if (isWhitespace(c) || isDelimiter(c)) break;
      i++;
    }
    return Buffer.from(this.buf.subarray(this.pos, i)).toString('latin1');
  }

  parseName(): PdfName {
    this.pos++; // '/'
    const out: number[] = [];
    while (this.pos < this.buf.length) {
      const c = this.buf[this.pos] as number;
      if (isWhitespace(c) || isDelimiter(c)) break;
      if (c === CH_HASH) {
        const h1 = hexValue(this.peek(1));
        const h2 = hexValue(this.peek(2));
        if (h1 >= 0 && h2 >= 0) {
          out.push(h1 * 16 + h2);
          this.pos += 3;
          continue;
        }
      }
      out.push(c);
      this.pos++;
    }
    return new PdfName(Buffer.from(out).toString('latin1'));
  }

  parseLiteralString(): PdfString {
    this.pos++; // '('
    const out: number[] = [];
    let depth = 1;

    while (this.pos < this.buf.length) {
      const c = this.buf[this.pos] as number;
      this.pos++;

      if (c === CH_BACKSLASH) {
        const e = this.peek();
        if (e < 0) break;
        this.pos++;
        switch (e) {
          case 0x6e: // n
            out.push(CH_LF);
            break;
          case 0x72: // r
            out.push(CH_CR);
            break;
          case 0x74: // t
            out.push(CH_TAB);
            break;
          case 0x62: // b
            out.push(0x08);
            break;
          case 0x66: // f
            out.push(CH_FF);
            break;
          case CH_LPAREN:
          case CH_RPAREN:
          case CH_BACKSLASH:
            out.push(e);
            break;
          case CH_CR:
            if (this.peek() === CH_LF) this.pos++;
            break;
          case CH_LF:
            break;
          default:
            if (e >= 0x30 && e <= 0x37) {
              let v = e - 0x30;
              for (let i = 0; i < 2; i++) {
                const d = this.peek();
                if (d >= 0x30 && d <= 0x37) {
                  v = v * 8 + (d - 0x30);
                  this.pos++;
                } else {
                  break;
                }
              }
              out.push(v & 0xff);
            } else {
              out.push(e);
            }
        }
        continue;
      }

      if (c === CH_LPAREN) {
        depth++;
        out.push(c);
        continue;
      }
      if (c === CH_RPAREN) {
        depth--;
        if (depth === 0) break;
        out.push(c);
        continue;
      }
      out.push(c);
    }

    return new PdfString(new Uint8Array(out));
  }

  parseHexString(): PdfString {
    this.pos++; // '<'
    const out: number[] = [];
    let high = -1;

    while (this.pos < this.buf.length) {
      const c = this.buf[this.pos] as number;
      this.pos++;
      if (c === CH_GT) break;
      if (isWhitespace(c)) continue;
      const v = hexValue(c);
      if (v < 0) continue;
      if (high < 0) {
        high = v;
      } else {
        out.push(high * 16 + v);
        high = -1;
      }
    }
    if (high >= 0) out.push(high * 16);

    return new PdfString(new Uint8Array(out));
  }

  parseArray(): PdfArray {
    this.pos++; // '['
    const items: PdfValue[] = [];
    for (;;) {
      this.skipWhitespace();
      const c = this.peek();
      if (c < 0) break;
      if (c === CH_RBRACKET) {
        this.pos++;
        break;
      }
      const before = this.pos;
      const v = this.parseValue();
      if (this.pos === before) {
        // 防止死循环
        this.pos++;
        continue;
      }
      items.push(v);
    }
    return new PdfArray(items);
  }

  parseDict(): PdfDict {
    this.pos += 2; // '<<'
    const dict = new PdfDict();

    for (;;) {
      this.skipWhitespace();
      const c = this.peek();
      if (c < 0) break;
      if (c === CH_GT && this.peek(1) === CH_GT) {
        this.pos += 2;
        break;
      }
      if (c !== CH_SLASH) {
        // 非法键：跳过这个值，避免死循环
        const before = this.pos;
        const junk = this.parseValue();
        if (this.pos === before) this.pos++;
        void junk;
        continue;
      }
      const key = this.parseName().value;
      const value = this.parseValue();
      dict.set(key, value);
    }

    return dict;
  }

  readNumber(): number {
    const start = this.pos;
    if (this.peek() === 0x2b || this.peek() === 0x2d) this.pos++;
    while (this.pos < this.buf.length) {
      const c = this.buf[this.pos] as number;
      if (isDigit(c) || c === 0x2e) this.pos++;
      else break;
    }
    const text = Buffer.from(this.buf.subarray(start, this.pos)).toString('latin1');
    const n = Number.parseFloat(text);
    return Number.isFinite(n) ? n : 0;
  }

  readInteger(): number {
    const start = this.pos;
    if (this.peek() === 0x2b || this.peek() === 0x2d) this.pos++;
    while (this.pos < this.buf.length && isDigit(this.buf[this.pos] as number)) {
      this.pos++;
    }
    const text = Buffer.from(this.buf.subarray(start, this.pos)).toString('latin1');
    const n = Number.parseInt(text, 10);
    return Number.isFinite(n) ? n : 0;
  }

  parseNumberOrRef(): PdfValue {
    const value = this.readNumber();

    // 尝试识别 `N G R`
    if (Number.isInteger(value) && value >= 0) {
      const save = this.pos;
      this.skipWhitespace();

      if (isDigit(this.peek())) {
        const genStart = this.pos;
        const gen = this.readInteger();
        this.skipWhitespace();

        if (this.peek() === CH_R) {
          const after = this.peek(1);
          if (after < 0 || isWhitespace(after) || isDelimiter(after)) {
            this.pos++;
            return new PdfRef(value, gen);
          }
        }
        this.pos = genStart;
      }
      this.pos = save;
    }

    return value;
  }
}

/** 从 `pos` 起解析一个值（便捷函数）。 */
export function parseValueAt(buf: Uint8Array, pos: number): { value: PdfValue; next: number } {
  const lexer = new Lexer(buf, pos);
  const value = lexer.parseValue();
  return { value, next: lexer.pos };
}
