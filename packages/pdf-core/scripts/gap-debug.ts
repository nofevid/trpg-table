/** 临时诊断：打印某一页的 x 覆盖剖面，看栏缝为什么没找到。 */

import { openPdfFile } from '../src/index.ts';
import { analyzeColumnGap, columnCoverProfile } from '../src/layout.ts';

const file = process.argv[2] ?? 'mod-example/[COC模组翻译]黄字的研究-An Invitation in Yellow-琳尼娜.pdf';
const pages = (process.argv[3] ?? '2').split(',').map((s) => Number.parseInt(s, 10) - 1);

const doc = openPdfFile(file);

for (const idx of pages) {
  const page = doc.pages[idx];
  if (!page) continue;

  const runs = page.layout.lines.flatMap((l) => l.runs);
  const profile = columnCoverProfile(runs);
  if (!profile) {
    console.log(`p${idx + 1}: 无剖面`);
    continue;
  }

  const { bodyLeft, bodyRight, cover } = profile;
  const a = analyzeColumnGap(runs);

  console.log(
    `--- p${idx + 1} runs=${runs.length} 版心=[${bodyLeft.toFixed(1)}, ${bodyRight.toFixed(1)}] gap=${a.gap?.toFixed(1) ?? 'undefined'} reason=${a.reason} kind=${page.layout.kind}`,
  );
  console.log(
    `    bestVal=${a.bestVal} bestIndex=${a.bestIndex} span=${a.span?.join('..')} 宽=${a.span ? a.span[1] - a.span[0] + 1 : '-'} leftWall=${a.leftWall?.toFixed(1)} rightWall=${a.rightWall?.toFixed(1)}`,
  );

  let line = '';
  for (let x = Math.floor(bodyLeft); x <= bodyRight; x += 10) {
    const i = Math.round(x - bodyLeft);
    const v = cover[i] ?? -1;
    line += `${x}:${v} `;
  }
  console.log('  ' + line);
}
