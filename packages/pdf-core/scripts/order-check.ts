/** 临时诊断：检查每页的阅读顺序是否「左栏读完 → 右栏读完」。 */

import { openPdfFile } from '../src/index.ts';

const file = process.argv[2] ?? 'mod-example/[COC模组翻译]黄字的研究-An Invitation in Yellow-琳尼娜.pdf';
const doc = openPdfFile(file);

doc.pages.forEach((page) => {
  const gap = page.layout.columnGap;
  const lines = page.layout.lines;

  if (gap === undefined) {
    console.log(`p${page.index + 1} 单栏 行=${lines.length}`);
    return;
  }

  const segments: Array<{ side: string; from: number; to: number }> = [];
  let current: { side: string; from: number; to: number } | undefined;

  lines.forEach((line, i) => {
    const side = line.x >= gap ? 'R' : 'L';
    if (!current || current.side !== side) {
      current = { side, from: i, to: i };
      segments.push(current);
    } else {
      current.to = i;
    }
  });

  const crossers = lines.filter((l) => l.x < gap && l.x + l.width > gap + 5).length;

  console.log(
    `p${page.index + 1} gap=${gap.toFixed(0)} 行=${lines.length} 段=${segments
      .map((s) => `${s.side}${s.from}-${s.to}`)
      .join(' ')} 跨缝行=${crossers}`,
  );
});
