/**
 * pdf-core 对外入口。
 *
 * 用法：
 * ```ts
 * const doc = openPdfFile('mod.pdf');
 * doc.structure.available   // 有没有结构树
 * doc.blocks                // 结构树摊平后的阅读顺序内容块
 * doc.pages[8].layout.kind  // 'single' | 'double' | 'mixed'
 * ```
 */

import { readFileSync } from 'node:fs';

import { parseContentStream, type ContentResult } from './content.ts';
import type { FontInfo } from './fonts.ts';
import { fontFor } from './fonts.ts';
import { analyzePage, findRepeatedBands, type PageLayout, type RepeatedBand } from './layout.ts';
import { PdfObjects, type PageEntry } from './objects.ts';
import { flattenStructure, readStructure, type StructBlock, type StructureSnapshot } from './struct.ts';
import type { TocEntry } from './types.ts';

export interface PageInfo {
  readonly index: number;
  readonly objNum: number;
  readonly width: number;
  readonly height: number;
  readonly layout: PageLayout;
}

export interface PdfDocument {
  readonly pageCount: number;
  readonly toc: readonly TocEntry[];
  readonly structure: StructureSnapshot;
  /** 结构树摊平后的内容块（没有结构树时为空）。 */
  readonly blocks: readonly StructBlock[];
  readonly pages: readonly PageInfo[];
  /** 跨页重复出现的页眉页脚带。 */
  readonly headerFooterBands: readonly RepeatedBand[];
}

const DEFAULT_PAGE = { width: 595.28, height: 841.89 };

export function openPdfFile(path: string): PdfDocument {
  return openPdf(readFileSync(path));
}

export function openPdf(bytes: Uint8Array): PdfDocument {
  const objs = new PdfObjects(bytes);
  const entries = objs.pages();

  const contents: ContentResult[] = entries.map((page: PageEntry) => {
    const cache = new Map<string, FontInfo>();
    const resolveFont = (name: string): FontInfo => {
      const cached = cache.get(name);
      if (cached) return cached;
      const info = fontFor(objs, page.resources, name);
      cache.set(name, info);
      return info;
    };
    return parseContentStream(page.contents, resolveFont);
  });

  const mcidText = new Map<number, Map<number, string>>();
  entries.forEach((page, i) => {
    mcidText.set(page.objNum, contents[i]!.mcidText);
  });

  const structure = readStructure(objs);
  const blocks = structure.root ? flattenStructure(structure.root, mcidText) : [];

  const pages: PageInfo[] = entries.map((page, i) => {
    const box = pageSize(objs, page);
    return {
      index: i,
      objNum: page.objNum,
      width: box.width,
      height: box.height,
      layout: analyzePage(contents[i]!.runs),
    };
  });

  const bands = findRepeatedBands(pages.map((p) => p.layout.lines));

  return {
    pageCount: pages.length,
    toc: readToc(objs),
    structure,
    blocks,
    pages,
    headerFooterBands: bands,
  };
}

function pageSize(objs: PdfObjects, page: PageEntry): { width: number; height: number } {
  const raw = page.dict.get('CropBox') ?? page.dict.get('MediaBox');
  const arr = objs.arrayOf(raw);
  if (arr && arr.length >= 4) {
    const nums = arr.slice(0, 4).map((v) => (typeof v === 'number' ? v : 0));
    const x0 = nums[0] as number;
    const y0 = nums[1] as number;
    const x1 = nums[2] as number;
    const y1 = nums[3] as number;
    const width = Math.abs(x1 - x0);
    const height = Math.abs(y1 - y0);
    if (width > 1 && height > 1) return { width, height };
  }
  return DEFAULT_PAGE;
}

/**
 * 读书签大纲。
 *
 * 现实里大多数 Word / WPS 导出的模组没有大纲，所以这个结果经常是空数组——
 * 不要把它当成主骨架，只当可选加速。
 */
function readToc(objs: PdfObjects): TocEntry[] {
  const catalog = objs.catalog();
  if (!catalog) return [];

  const outlines = objs.dictOf(catalog.dict.get('Outlines'));
  if (!outlines) return [];

  const out: TocEntry[] = [];
  walkOutlines(objs, outlines.get('First'), 1, out);
  return out;
}

function walkOutlines(
  objs: PdfObjects,
  first: Parameters<PdfObjects['dictOf']>[0],
  level: number,
  out: TocEntry[],
): void {
  let current = first;
  let guard = 0;

  while (current !== undefined && current !== null && guard++ < 10000) {
    const dict = objs.dictOf(current);
    if (!dict) break;

    const title = dict.str('Title')?.asText().trim() ?? '';
    if (title.length > 0) {
      out.push({
        title,
        level,
        pageObjNum: destinationPage(objs, dict),
      });
    }

    const child = dict.get('First');
    if (child !== undefined) walkOutlines(objs, child, level + 1, out);

    current = dict.get('Next');
  }
}

function destinationPage(objs: PdfObjects, item: { get(k: string): unknown }): number | undefined {
  const dict = item as { get(k: string): Parameters<PdfObjects['dictOf']>[0] };
  const direct = dict.get('Dest');
  const action = objs.dictOf(dict.get('A'));
  const target = direct ?? action?.get('D');
  const arr = objs.arrayOf(target);
  if (arr && arr.length > 0) {
    const first = arr[0];
    const num = objs.objNumOf(first as never);
    if (num !== undefined) return num;
  }
  return undefined;
}

export { decodeStream } from './objects.ts';
export { parseToUnicode, buildFontInfo, decodeText, textWidth } from './fonts.ts';
export { parseContentStream } from './content.ts';
export { clusterRows, findColumnGap, readingOrder, analyzePage, findRepeatedBands } from './layout.ts';
export { readStructure, flattenStructure, isBoxLike } from './struct.ts';
export type { StructBlock, StructureSnapshot } from './struct.ts';
export type { ContentResult, TextRun } from './content.ts';
export type { FontInfo } from './fonts.ts';
export type { Line, PageLayout, PageLayoutKind, RepeatedBand } from './layout.ts';
export type * from './types.ts';
