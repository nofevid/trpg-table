/**
 * PDF 对象模型。
 *
 * 只做「够用」的一层抽象：不追求覆盖 PDF 1.7 全部特性，只覆盖模组文件里
 * 真实会出现的结构（文本、表格、结构树、书签）。
 *
 * 注意：全部使用「可擦除语法」（不用 enum / namespace / 构造函数参数属性），
 * 这样 Node 可以直接执行 .ts 源文件，不需要构建步骤。
 */

export class PdfName {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }

  toString(): string {
    return `/${this.value}`;
  }
}

export class PdfRef {
  readonly num: number;
  readonly gen: number;

  constructor(num: number, gen: number = 0) {
    this.num = num;
    this.gen = gen;
  }

  toString(): string {
    return `${this.num} ${this.gen} R`;
  }
}

/** 字面量字符串 `(...)` 或十六进制字符串 `<...>` 的原始字节。 */
export class PdfString {
  readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  static fromText(text: string): PdfString {
    return new PdfString(new Uint8Array(Buffer.from(text, 'utf8')));
  }

  /** 按 UTF-16BE（带 BOM）优先、其次 UTF-8、最后 latin1 解码。 */
  asText(): string {
    const b = this.bytes;
    if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
      return new TextDecoder('utf-16be').decode(b.subarray(2));
    }
    if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) {
      return new TextDecoder('utf-16le').decode(b.subarray(2));
    }
    // 无 BOM 的 PDFDocEncoding / UTF-8：先按 UTF-8 试，失败退回 latin1。
    const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(b);
    return utf8.includes('\uFFFD') ? new TextDecoder('latin1').decode(b) : utf8;
  }
}

export type PdfValue =
  | null
  | boolean
  | number
  | PdfString
  | PdfName
  | PdfArray
  | PdfDict
  | PdfRef
  | PdfStream;

export class PdfArray {
  readonly items: PdfValue[];

  constructor(items: PdfValue[]) {
    this.items = items;
  }
}

export class PdfDict {
  readonly map: Map<string, PdfValue>;

  constructor(entries?: Iterable<[string, PdfValue]>) {
    this.map = new Map(entries);
  }

  get(key: string): PdfValue | undefined {
    return this.map.get(key);
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  set(key: string, value: PdfValue): void {
    this.map.set(key, value);
  }

  /** 取 name 值（去掉前导 `/`）。 */
  name(key: string): string | undefined {
    const v = this.map.get(key);
    return v instanceof PdfName ? v.value : undefined;
  }

  num(key: string): number | undefined {
    const v = this.map.get(key);
    return typeof v === 'number' ? v : undefined;
  }

  str(key: string): PdfString | undefined {
    const v = this.map.get(key);
    return v instanceof PdfString ? v : undefined;
  }

  dict(key: string): PdfDict | undefined {
    const v = this.map.get(key);
    return v instanceof PdfDict ? v : undefined;
  }

  array(key: string): PdfArray | undefined {
    const v = this.map.get(key);
    return v instanceof PdfArray ? v : undefined;
  }

  ref(key: string): PdfRef | undefined {
    const v = this.map.get(key);
    return v instanceof PdfRef ? v : undefined;
  }
}

/** 带原始字节的流对象（`dict` 之外的 `stream … endstream`）。 */
export interface PdfStream {
  readonly dict: PdfDict;
  readonly raw: Uint8Array;
  /** `/Length` 与实际读到的不一致时以实际为准，用此标记。 */
  readonly truncated: boolean;
}

export function isStream(v: unknown): v is PdfStream {
  return (
    typeof v === 'object' &&
    v !== null &&
    'dict' in v &&
    'raw' in v &&
    (v as PdfStream).dict instanceof PdfDict
  );
}

/** 结构树里的一个元素（`/S` + 子节点 + 关联的页与 MCID）。 */
export interface StructElement {
  /** 标签名，如 `P` / `H1` / `Table` / `Textbox` / `Span`。 */
  readonly tag: string;
  /** 该元素所在的页对象号（继承自上级）。 */
  readonly pageObjNum?: number;
  /** 叶子元素对应的 MCID（`/K` 为整数或 `/Type /MCR` 时存在）。 */
  readonly mcid?: number;
  readonly children: StructElement[];
}

export interface TocEntry {
  readonly title: string;
  /** 层级，从 1 开始。 */
  readonly level: number;
  readonly pageObjNum?: number;
}
