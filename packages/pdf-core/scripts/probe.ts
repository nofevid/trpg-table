/**
 * 手动探针：打印两份真实模组的解析结果，用来校准断言。
 * 运行：node packages/pdf-core/scripts/probe.ts
 */

import { openPdfFile } from '../src/index.ts';

const FILES = [
  'mod-example/八月二十二日 - 2.0(1).pdf',
  'mod-example/[COC模组翻译]黄字的研究-An Invitation in Yellow-琳尼娜.pdf',
];

for (const file of FILES) {
  const started = performance.now();
  const doc = openPdfFile(file);
  const elapsed = (performance.now() - started).toFixed(0);

  console.log('='.repeat(70));
  console.log(file);
  console.log(`解析耗时 ${elapsed}ms`);
  console.log(`页数 ${doc.pageCount}`);
  console.log(`书签 ${doc.toc.length} 条`);
  console.log(
    `结构树 available=${doc.structure.available} elements=${doc.structure.elementCount}`,
  );

  const tags = [...doc.structure.tagCounts.entries()].sort((a, b) => b[1] - a[1]);
  console.log('标签分布: ' + tags.map(([t, n]) => `${t}:${n}`).join(' '));

  console.log(`结构块 ${doc.blocks.length} 个`);
  for (const b of doc.blocks.slice(0, 6)) {
    console.log(`  [${b.path.join('>')}] ${b.text.slice(0, 60)}`);
  }

  const kinds = doc.pages.map((p) => p.layout.kind);
  const tally: Record<string, number> = {};
  for (const k of kinds) tally[k] = (tally[k] ?? 0) + 1;
  console.log('版式: ' + JSON.stringify(tally));

  doc.pages.forEach((p) => {
    const first = p.layout.lines[0]?.text.slice(0, 40) ?? '(空)';
    console.log(
      `  p${p.index + 1} ${p.layout.kind} 行=${p.layout.lines.length} gap=${
        p.layout.columnGap?.toFixed(0) ?? '-'
      } 首行「${first}」`,
    );
  });

  console.log(
    '重复带: ' +
      doc.headerFooterBands
        .slice(0, 6)
        .map((b) => `y=${b.y.toFixed(0)}(${b.pages}页)`)
        .join(' '),
  );
}
