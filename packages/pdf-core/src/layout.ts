/**
 * 几何兜底：没有结构树（或结构树只有 `/P`）时，靠坐标还原阅读顺序。
 *
 * 三个反直觉的点，都是被真实模组打出来的：
 *
 * 1. **不能在行内找栏缝**。双栏页的两栏是两条独立文本流、基线互相错开，
 *    行内空白命中率只有 11%–25%。
 * 2. **不能先聚行再找栏缝**。左右栏偶尔会有行恰好对齐同一 y，一旦先聚行，
 *    这两行会被合并成一条横跨全宽的长行，栏缝处的覆盖率就被抬起来，缝就找不到了。
 *    正确顺序是：用**关注点更细的 run** 找缝 → 按 run 起点分栏 → 栏内聚行。
 * 3. **不能按中心 x 分栏**。长行的中心会越过栏缝，把一行劈成两半。
 *    只能按**起点 x** 判断归属。
 */

import { textWidth } from './fonts.ts';
import type { TextRun } from './content.ts';

export interface Line {
  /** 合并后取最左端的 x。 */
  x: number;
  /** 基线 y（PDF 坐标系，向上为正）。 */
  y: number;
  width: number;
  text: string;
  readonly runs: TextRun[];
}

export type PageLayoutKind = 'single' | 'double' | 'mixed' | 'empty';

export interface PageLayout {
  readonly kind: PageLayoutKind;
  /** 栏缝中心 x；单栏时为 undefined。 */
  readonly columnGap?: number;
  /** 已按阅读顺序排好的行。 */
  readonly lines: Line[];
}

function compareByY(a: Line, b: Line): number {
  if (Math.abs(a.y - b.y) > 1) return b.y - a.y;
  return a.x - b.x;
}

/** 按「同一基线」把 run 聚成行（只在同一栏内调用）。 */
export function clusterRows(runs: readonly TextRun[]): Line[] {
  const sorted = [...runs].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: Line[] = [];

  for (const run of sorted) {
    const width = textWidth(run.text, run.size);
    const last = lines[lines.length - 1];
    const tolerance = Math.max(1.5, run.size * 0.35);

    if (last && Math.abs(last.y - run.y) <= tolerance) {
      const x0 = Math.min(last.x, run.x);
      const x1 = Math.max(last.x + last.width, run.x + width);
      last.x = x0;
      last.width = x1 - x0;
      last.text += run.text;
      last.runs.push(run);
      continue;
    }

    lines.push({ x: run.x, y: run.y, width, text: run.text, runs: [run] });
  }

  return lines;
}

/**
 * 用 run 的 x 覆盖投影找栏缝。
 *
 * 把每个 run 的 `[x, x+width]` 投影到 1pt 粒度，覆盖率低（默认 ≤5%）的连续区间
 * 就是没有任何一段文字跨过的地方——那正是栏缝。要求它落在版心 15%–85% 之间，
 * 避免把左右页边距当成栏缝。
 */
/**
 * 计算 x 方向的覆盖剖面（诊断与测试用）。
 * `cover[i]` 表示有多少个 run 的横向范围覆盖了 `bodyLeft + i`。
 */
export function columnCoverProfile(runs: readonly TextRun[]): {
  bodyLeft: number;
  bodyRight: number;
  cover: Int32Array;
} | undefined {
  if (runs.length === 0) return undefined;

  const bodyLeft = Math.min(...runs.map((r) => r.x));
  const bodyRight = Math.max(...runs.map((r) => r.x + textWidth(r.text, r.size)));
  const bodyWidth = bodyRight - bodyLeft;
  if (bodyWidth < 120) return undefined;

  const bins = Math.ceil(bodyWidth) + 1;
  const cover = new Int32Array(bins);

  for (const run of runs) {
    const x1 = run.x + textWidth(run.text, run.size);
    const a = Math.max(0, Math.floor(run.x - bodyLeft));
    const b = Math.min(bins - 1, Math.ceil(x1 - bodyLeft));
    for (let i = a; i < b; i++) cover[i] = (cover[i] as number) + 1;
  }

  return { bodyLeft, bodyRight, cover };
}

export interface GapAnalysis {
  readonly gap?: number;
  readonly reason: string;
  readonly bodyLeft?: number;
  readonly bestVal?: number;
  readonly bestIndex?: number;
  readonly span?: readonly [number, number];
  readonly leftWall?: number;
  readonly rightWall?: number;
}

/** 诊断版：把每一步的中间量都吐出来。 */
export function analyzeColumnGap(runs: readonly TextRun[], maxGapWidth: number = 80): GapAnalysis {
  if (runs.length < 20) return { reason: 'runs-too-few' };

  const profile = columnCoverProfile(runs);
  if (!profile) return { reason: 'no-profile' };

  const { bodyLeft, cover } = profile;
  const bins = cover.length;
  const lo = Math.floor(bins * 0.15);
  const hi = Math.ceil(bins * 0.85);

  let bestI = -1;
  let bestVal = Number.POSITIVE_INFINITY;

  for (let i = lo; i <= hi; i++) {
    const v = cover[i] as number;
    if (v < bestVal) {
      bestVal = v;
      bestI = i;
    }
  }

  if (bestI < 0) return { reason: 'no-valley', bodyLeft };

  let start = bestI;
  let end = bestI;
  const reach = 40;
  // 谷底不一定平：两侧各差 1 个 run 的桶也属于缝内，否则会得到一条只有 2pt 宽的假缝
  const floor = bestVal + 1;
  while (start > 0 && (cover[start - 1] as number) <= floor && bestI - start < reach) start--;
  while (end < bins - 1 && (cover[end + 1] as number) <= floor && end - bestI < reach) end++;

  const width = end - start + 1;

  const mean = (from: number, to: number): number => {
    let sum = 0;
    let n = 0;
    for (let i = Math.max(0, from); i <= Math.min(bins - 1, to); i++) {
      sum += cover[i] as number;
      n++;
    }
    return n === 0 ? 0 : sum / n;
  };

  const leftWall = mean(start - 40, start - 3);
  const rightWall = mean(end + 3, end + 40);
  const base = { bodyLeft, bestVal, bestIndex: bestI, span: [start, end] as const, leftWall, rightWall };

  if (width > maxGapWidth) return { ...base, reason: `too-wide(${width})` };
  if (width < 3) return { ...base, reason: `too-narrow(${width})` };

  const needed = Math.max(3, bestVal * 1.5);

  // 两侧都得有实质内容撑着。只有一侧有内容时，那条「缝」很可能是段落里的
  // 空白或图片周围的白边，判成双栏会把段落劈成两半——比判成单栏更糟。
  if (leftWall < needed || rightWall < needed) {
    return {
      ...base,
      reason: `weak-wall(left=${leftWall.toFixed(1)}, right=${rightWall.toFixed(1)}, need=${needed.toFixed(1)})`,
    };
  }

  return { ...base, reason: 'ok', gap: bodyLeft + (start + end) / 2 };
}

export function findColumnGapFromRuns(
  runs: readonly TextRun[],
  maxGapWidth: number = 80,
): number | undefined {
  return analyzeColumnGap(runs, maxGapWidth).gap;
}

/** 兼容旧签名：从行找缝（行已经跨栏合并过时不可靠，优先用 run 版本）。 */
export function findColumnGap(lines: readonly Line[]): number | undefined {
  return findColumnGapFromRuns(lines.flatMap((l) => l.runs));
}

/** 按阅读顺序排序：单栏按 y 降序；双栏左栏读完再读右栏。 */
export function readingOrder(lines: readonly Line[], columnGap?: number): Line[] {
  if (columnGap === undefined) return [...lines].sort(compareByY);

  const left: Line[] = [];
  const right: Line[] = [];

  for (const line of lines) {
    // 按起点判断：长行的中心会越过栏缝，只有起点是可靠的
    if (line.x < columnGap) left.push(line);
    else right.push(line);
  }

  if (left.length === 0 || right.length === 0) return [...lines].sort(compareByY);

  left.sort(compareByY);
  right.sort(compareByY);
  return [...left, ...right];
}

/**
 * 单页版面分析入口。
 *
 * 顺序很关键：**先找缝 → 再分栏 → 最后栏内聚行**。
 */
export function analyzePage(runs: readonly TextRun[]): PageLayout {
  if (runs.length === 0) return { kind: 'empty', lines: [] };

  const gap = findColumnGapFromRuns(runs);

  if (gap === undefined) {
    return { kind: 'single', lines: clusterRows(runs).sort(compareByY) };
  }

  const leftRuns = runs.filter((r) => r.x < gap);
  const rightRuns = runs.filter((r) => r.x >= gap);

  // 两栏都得有实质内容，否则说明这条「缝」是别的东西（封面、单栏缩进等）
  const minorRatio = Math.min(leftRuns.length, rightRuns.length) / runs.length;

  if (minorRatio < 0.15) {
    return { kind: 'mixed', columnGap: gap, lines: clusterRows(runs).sort(compareByY) };
  }

  const left = clusterRows(leftRuns).sort(compareByY);
  const right = clusterRows(rightRuns).sort(compareByY);

  return { kind: 'double', columnGap: gap, lines: [...left, ...right] };
}

/**
 * 跨页找出重复出现的「页眉页脚带」。
 *
 * 判据和设计文档一致：同一 y 带（±2pt）、出现在 ≥60% 的页面上、文本短。
 * 只统计不删除——删除按页进行，因为有的页可能没有页眉。
 */
export interface RepeatedBand {
  readonly y: number;
  readonly pages: number;
  readonly samples: readonly string[];
}

export function findRepeatedBands(
  pages: readonly (readonly Line[])[],
  minPageRatio: number = 0.6,
): RepeatedBand[] {
  if (pages.length === 0) return [];

  interface Bucket {
    y: number;
    pageSet: Set<number>;
    samples: string[];
  }

  const buckets: Bucket[] = [];

  pages.forEach((lines, pageIndex) => {
    for (const line of lines) {
      const text = line.text.trim();
      if (text.length === 0) continue;
      // 页眉页脚都很短
      if (text.length > 40) continue;

      let bucket = buckets.find((b) => Math.abs(b.y - line.y) <= 2);
      if (!bucket) {
        bucket = { y: line.y, pageSet: new Set(), samples: [] };
        buckets.push(bucket);
      }
      bucket.pageSet.add(pageIndex);
      if (bucket.samples.length < 3) bucket.samples.push(text);
    }
  });

  const minPages = Math.max(2, Math.ceil(pages.length * minPageRatio));

  return buckets
    .filter((b) => b.pageSet.size >= minPages)
    .map((b) => ({ y: b.y, pages: b.pageSet.size, samples: b.samples }))
    .sort((a, b) => b.pages - a.pages);
}
