/** 临时诊断：查内容流与字体为什么拿不到文字。 */

import { readFileSync } from 'node:fs';

import { parseContentStream } from '../src/content.ts';
import { buildFontInfo, fontFor } from '../src/fonts.ts';
import { decodeStream, PdfObjects } from '../src/objects.ts';

const buf = readFileSync('mod-example/八月二十二日 - 2.0(1).pdf');
const objs = new PdfObjects(buf);
const pages = objs.pages();

console.log('对象总数', objs.map.size);
console.log('页数', pages.length);

const p0 = pages[0];
if (!p0) throw new Error('no page');

console.log('p0 objNum', p0.objNum);
console.log('p0 contents 字节', p0.contents.length);
console.log('p0 resources', p0.resources ? [...p0.resources.map.keys()] : null);

const fontDict = p0.resources ? objs.dictOf(p0.resources.get('Font')) : undefined;
console.log('Font 键', fontDict ? [...fontDict.map.keys()] : null);

if (fontDict) {
  for (const [name, ref] of fontDict.map) {
    const fd = objs.dictOf(ref);
    const tu = fd ? objs.streamOf(fd.get('ToUnicode')) : undefined;
    console.log(
      `  字体 ${name}: subtype=${fd?.name('Subtype')} encoding=${fd?.name('Encoding')} ToUnicode=${tu ? tu.raw.length + 'B' : 'none'}`,
    );
    if (fd) {
      const info = buildFontInfo(objs, fd);
      console.log(`    cmap 条目 ${info.cmap.size} codeWidth ${info.codeWidth}`);
    }
  }
}

// 内容流解压后长什么样
try {
  const inflated = decodeStream({ dict: p0.dict, raw: p0.contents, truncated: false });
  const head = Buffer.from(inflated.subarray(0, 300)).toString('latin1');
  console.log('内容流前 300 字节:', JSON.stringify(head));
  console.log('解压后长度', inflated.length);
} catch (err) {
  console.log('内容流解压失败', err);
}

const cache = new Map<string, ReturnType<typeof fontFor>>();
const result = parseContentStream(p0.contents, (name) => {
  const hit = cache.get(name);
  if (hit) return hit;
  const info = fontFor(objs, p0.resources, name);
  cache.set(name, info);
  return info;
});

console.log('runs', result.runs.length, 'mcid', result.mcidText.size);
for (const run of result.runs.slice(0, 8)) {
  console.log(`  run y=${run.y.toFixed(1)} x=${run.x.toFixed(1)} size=${run.size} 「${run.text.slice(0, 30)}」`);
}
