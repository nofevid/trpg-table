/** 临时诊断：看某一页的行坐标分布，判断栏缝为什么没找到。 */

import { openPdfFile } from '../src/index.ts';

const file = process.argv[2] ?? 'mod-example/[COC模组翻译]黄字的研究-An Invitation in Yellow-琳尼娜.pdf';
const wanted = (process.argv[3] ?? '2').split(',').map((s) => Number.parseInt(s, 10) - 1);

const doc = openPdfFile(file);
console.log(`页数 ${doc.pageCount}`);

for (const idx of wanted) {
  const page = doc.pages[idx];
  if (!page) continue;
  console.log(
    `--- p${idx + 1} kind=${page.layout.kind} gap=${page.layout.columnGap?.toFixed(1) ?? '-'} 行=${page.layout.lines.length}`,
  );
  for (const l of page.layout.lines.slice(0, 30)) {
    console.log(
      `  y=${l.y.toFixed(1).padStart(6)} x=${l.x.toFixed(1).padStart(6)} x1=${(l.x + l.width).toFixed(1).padStart(6)} 「${l.text.slice(0, 28)}」`,
    );
  }
}
