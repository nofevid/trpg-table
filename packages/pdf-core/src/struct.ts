/**
 * 结构树（Tagged PDF）读取。
 *
 * 这是「标记 PDF」比几何方法强的地方：`/K` 的遍历顺序就是作者认定的阅读顺序，
 * 段落、标题、表格、文本框都有明确标签，不用靠猜。
 *
 * 现实情况（两份真实 CoC 模组实测）：
 * - 绝大多数 PDF 都带结构树，但标签粗细不一：可能只有 `/P` 和 `/Span`，
 *   也可能带 `/H1`、`/Table`、`/Textbox`；
 * - 所以「有结构树」不等于「有标题层级」，缺 `/H*` 时仍要靠字号聚类补层级。
 */

import type { PdfObjects } from './objects.ts';
import { PdfArray, PdfDict, type PdfValue, type StructElement } from './types.ts';

/** 会被当成「一个内容块」的标签。 */
const BLOCK_TAGS = new Set([
  'P',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'L',
  'L1',
  'L2',
  'LI',
  'Lbl',
  'TD',
  'TH',
  'TR',
  'Table',
  'THead',
  'TBody',
  'Figure',
  'Textbox',
  'Caption',
  'Footnote',
  'BlockQuote',
  'Document',
]);

export interface StructureSnapshot {
  readonly available: boolean;
  readonly root?: StructElement;
  readonly tagCounts: ReadonlyMap<string, number>;
  /** 元素总数（不含根）。 */
  readonly elementCount: number;
}

export function readStructure(objs: PdfObjects): StructureSnapshot {
  const empty: StructureSnapshot = {
    available: false,
    tagCounts: new Map(),
    elementCount: 0,
  };

  const catalog = objs.catalog();
  if (!catalog) return empty;

  const rootValue = catalog.dict.get('StructTreeRoot');
  if (rootValue === undefined) return empty;

  const rootDict = objs.dictOf(rootValue);
  if (!rootDict) return empty;

  const root = walkValue(objs, rootValue, -1, new Set<number>());
  if (!root) return empty;

  const tagCounts = new Map<string, number>();
  let elementCount = 0;

  const count = (el: StructElement): void => {
    // 只统计真正的结构元素（MCID 叶子是内容流的指针，不算元素）
    if (el.mcid === undefined) {
      elementCount++;
      tagCounts.set(el.tag, (tagCounts.get(el.tag) ?? 0) + 1);
    }
    for (const c of el.children) count(c);
  };
  for (const c of root.children) count(c);
  if (root.tag !== 'StructTreeRoot') tagCounts.set(root.tag, (tagCounts.get(root.tag) ?? 0) + 1);

  return { available: true, root, tagCounts, elementCount };
}

function walkValue(
  objs: PdfObjects,
  value: PdfValue,
  inheritedPage: number,
  seen: Set<number>,
): StructElement | undefined {
  const objNum = objs.objNumOf(value);
  if (objNum !== undefined) {
    if (seen.has(objNum)) return undefined;
    seen.add(objNum);
  }

  const dict = objs.dictOf(value);
  if (!dict) return undefined;

  const tag = dict.name('S') ?? 'Unknown';
  const page = objs.objNumOf(dict.get('Pg')) ?? inheritedPage;

  const children: StructElement[] = [];
  collectKids(objs, dict.get('K'), page, seen, children);

  return {
    tag,
    pageObjNum: page >= 0 ? page : undefined,
    children,
  };
}

function collectKids(
  objs: PdfObjects,
  k: PdfValue | undefined,
  page: number,
  seen: Set<number>,
  out: StructElement[],
): void {
  if (k === undefined || k === null) return;

  if (typeof k === 'number') {
    out.push({ tag: 'MCID', pageObjNum: page, mcid: k, children: [] });
    return;
  }

  if (k instanceof PdfArray) {
    for (const item of k.items) collectKids(objs, item, page, seen, out);
    return;
  }

  const dict = objs.dictOf(k);
  if (!dict) return;

  // 标记内容引用：`/K <</Type /MCR /Pg 3 0 R /MCID 17>>`
  if (dict.name('Type') === 'MCR' || dict.has('MCID')) {
    const mcid = dict.num('MCID');
    const pg = objs.objNumOf(dict.get('Pg')) ?? page;
    if (typeof mcid === 'number') {
      out.push({ tag: 'MCR', pageObjNum: pg, mcid, children: [] });
    }
    return;
  }

  const child = walkValue(objs, k, page, seen);
  if (child) out.push(child);
}

/** 结构树摊平后的一个「内容块」。 */
export interface StructBlock {
  /** 块本身的标签（`P` / `H2` / `TD` …）。 */
  readonly tag: string;
  /** 从根到该块的标签链，用来判断「这是正文还是文本框」。 */
  readonly path: readonly string[];
  readonly pageObjNum?: number;
  readonly text: string;
}

/**
 * 按 `/K` 的顺序摊平成内容块。
 *
 * 只输出「块级」元素（段落、标题、单元格、文本框……），块内的 `/Span`
 * 会被合并进所属块——Span 是行内片段，单独拿出来没有意义。
 */
export function flattenStructure(
  root: StructElement,
  mcidText: ReadonlyMap<number, Map<number, string>>,
): StructBlock[] {
  const out: StructBlock[] = [];

  const textOf = (el: StructElement): string => {
    if (el.mcid !== undefined) {
      const page = el.pageObjNum;
      if (page === undefined) return '';
      return mcidText.get(page)?.get(el.mcid) ?? '';
    }
    let s = '';
    for (const c of el.children) s += textOf(c);
    return s;
  };

  const visit = (el: StructElement, path: string[]): void => {
    if (el.mcid !== undefined) return;

    const isBlock = BLOCK_TAGS.has(el.tag);
    const nextPath = [...path, el.tag];

    if (isBlock && el.tag !== 'Document') {
      const text = textOf(el).replace(/\s+/g, ' ').trim();
      if (text.length > 0) {
        out.push({ tag: el.tag, path: nextPath, pageObjNum: el.pageObjNum, text });
      }
      return;
    }

    for (const c of el.children) visit(c, nextPath);
  };

  visit(root, []);
  return out;
}

/** 判断一个块的祖先链里有没有文本框/边栏类标签。 */
export function isBoxLike(path: readonly string[]): boolean {
  return path.some((t) => t === 'Textbox' || t === 'Figure' || t === 'Aside' || t === 'Note');
}

export type { PdfDict };
