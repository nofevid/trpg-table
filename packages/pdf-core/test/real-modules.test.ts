/**
 * 用两份真实 CoC 模组做回归。
 *
 * 这些数字不是猜的，是先用 Python 原型（`tools/` 下九个脚本）逐页量出来的：
 * 页数、书签、结构元素数、字号、栏缝、表格数。TS 实现必须复现它们，
 * 否则说明解析链路上有东西被静默丢了。
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';

import { openPdfFile } from '../src/index.ts';

const MODULE_A = 'mod-example/八月二十二日 - 2.0(1).pdf';
const MODULE_B = 'mod-example/[COC模组翻译]黄字的研究-An Invitation in Yellow-琳尼娜.pdf';

// 两份模组有版权，不入库（见 README）。缺失时整组跳过，而不是报红。
const missing = [MODULE_A, MODULE_B].filter((path) => !existsSync(path));
const SKIP = missing.length > 0 ? `模组样例未提供：${missing.join('、')}` : false;

const it = (name: string, fn: () => void): void => {
  test(name, { skip: SKIP }, fn);
};

it('模组 A：基本结构', () => {
  const doc = openPdfFile(MODULE_A);

  assert.equal(doc.pageCount, 14);
  // 两份样例都没有书签大纲——这是设计文档里被实测推翻的那条假设
  assert.equal(doc.toc.length, 0);
  assert.equal(doc.structure.available, true);

  assert.equal(doc.structure.tagCounts.get('Table'), 3);
  assert.equal(doc.structure.tagCounts.get('Textbox'), 15);
  assert.equal(doc.structure.tagCounts.get('TH'), 16);
  assert.equal(doc.structure.tagCounts.get('TD'), 14);
  // 没有 H1–H6：这份文件用字号表达层级，结构树里只有 P
  assert.equal(doc.structure.tagCounts.get('H1'), undefined);
});

it('模组 A：双栏页的栏缝落在 300 附近', () => {
  const doc = openPdfFile(MODULE_A);
  const doubles = doc.pages.filter((p) => p.layout.kind === 'double');

  assert.equal(doubles.length, 7);

  for (const page of doubles) {
    const gap = page.layout.columnGap;
    assert.ok(gap !== undefined, `p${page.index + 1} 判成双栏却没有栏缝`);
    assert.ok(gap > 295 && gap < 315, `p${page.index + 1} 栏缝 ${gap} 偏离实测区间`);
  }
});

it('模组 A：阅读顺序是左栏读完再右栏', () => {
  const doc = openPdfFile(MODULE_A);

  for (const page of doc.pages) {
    if (page.layout.kind !== 'double') continue;

    const gap = page.layout.columnGap;
    assert.ok(gap !== undefined);

    const sides: string[] = [];
    for (const line of page.layout.lines) {
      const side = line.x >= gap ? 'R' : 'L';
      if (sides[sides.length - 1] !== side) sides.push(side);
    }

    assert.deepEqual(sides, ['L', 'R'], `p${page.index + 1} 出现左右交错：${sides.join('')}`);
  }
});

it('模组 A：结构块拿到了真实文字', () => {
  const doc = openPdfFile(MODULE_A);

  assert.ok(doc.blocks.length > 100, `结构块只有 ${doc.blocks.length} 个`);

  const table = doc.blocks.find((b) => b.path.includes('Table'));
  assert.ok(table, '没找到 Table 结构块');
  assert.match(table.text, /联系方式/);
  assert.match(table.text, /1725145629@qq\.com/);

  // 传单在结构树里是 Textbox，而不是和正文一样的 P
  const box = doc.blocks.find((b) => b.path.includes('Textbox'));
  assert.ok(box, '没找到 Textbox 结构块');
  assert.ok(box.text.length > 20);
});

it('模组 B：基本结构', () => {
  const doc = openPdfFile(MODULE_B);

  assert.equal(doc.pageCount, 15);
  assert.equal(doc.toc.length, 0);
  assert.equal(doc.structure.available, true);

  assert.equal(doc.structure.tagCounts.get('H1'), 3);
  assert.equal(doc.structure.tagCounts.get('Table'), 9);
  assert.equal(doc.structure.tagCounts.get('TH'), 24);
});

it('模组 B：绝大部分页面是双栏，栏缝落在 292 附近', () => {
  const doc = openPdfFile(MODULE_B);
  const doubles = doc.pages.filter((p) => p.layout.kind === 'double');

  // 封面、事件时间表、NPC 数据页内容稀疏，保守判为单栏
  assert.ok(doubles.length >= 12, `双栏页只有 ${doubles.length} 页`);

  for (const page of doubles) {
    const gap = page.layout.columnGap;
    assert.ok(gap !== undefined);
    assert.ok(gap > 285 && gap < 305, `p${page.index + 1} 栏缝 ${gap} 偏离实测区间`);
  }
});

it('模组 B：p9 左栏全部读完才进右栏（与 Python 原型结论一致）', () => {
  const doc = openPdfFile(MODULE_B);
  const page = doc.pages[8];
  assert.ok(page);
  assert.equal(page.layout.kind, 'double');

  const gap = page.layout.columnGap;
  assert.ok(gap !== undefined);

  const lines = page.layout.lines;
  const firstRight = lines.findIndex((l) => l.x >= gap);
  assert.ok(firstRight > 0, '整页都判到了右栏');

  for (let i = 0; i < firstRight; i++) {
    assert.ok((lines[i] as (typeof lines)[number]).x < gap, `第 ${i} 行本该在左栏`);
  }
  for (let i = firstRight; i < lines.length; i++) {
    assert.ok((lines[i] as (typeof lines)[number]).x >= gap, `第 ${i} 行本该在右栏`);
  }

  // 左栏第一句是这一节的小标题
  assert.match((lines[0] as (typeof lines)[number]).text, /当夜/);
});

it('两份文件都能识别出固定的页眉页脚带', () => {
  const a = openPdfFile(MODULE_A);
  const b = openPdfFile(MODULE_B);

  const aBands = a.headerFooterBands.map((band) => band.y.toFixed(0));
  assert.ok(aBands.includes('805'), `A 的页眉带没找到：${aBands.join(',')}`);
  assert.ok(aBands.includes('44'), `A 的页脚带没找到：${aBands.join(',')}`);

  const bBands = b.headerFooterBands.map((band) => band.y.toFixed(0));
  assert.ok(bBands.length > 0, 'B 没有识别出任何重复带');
});
