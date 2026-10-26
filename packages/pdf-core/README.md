# pdf-core

把一份 PDF 模组变成**带阅读顺序的结构块序列**，供后续实体抽取使用。

不依赖任何第三方运行时库（只用 Node 内置的 `zlib` / `Buffer`）。这是刻意的：
`pdfjs-dist` 的 `getTextContent()` 只给字符坐标，**不暴露 PDF 结构树**，
而结构树恰好是这份设计里最有价值的信号（见 `DESIGN.md` §9.2）。

## 四层信息源，从上往下退化

| 层 | 来源 | 什么时候有 |
| --- | --- | --- |
| 0 | `/StructTreeRoot` 结构树 | 用 Word / InDesign / LaTeX 之类「标记 PDF」的工具导出的才有 |
| 1 | 字号层级 | 几乎总有；正文与标题的字号差通常 ≥1.15 倍 |
| 2 | 几何（xy-cut） | 总有，但只能定顺序、定不了层级 |
| 3 | 书签大纲 `/Outlines` | 实测两份真实模组**都没有**，不能当主力 |

所以 `openPdf().structure.available` 为真时优先用结构树，
否则退到字号 + 几何。两条路的输出是同一个 `StructBlock[]`。

## 用法

```ts
import { openPdfFile } from './src/index.ts';

const doc = openPdfFile('mod-example/八月二十二日 - 2.0(1).pdf');

doc.pageCount;              // 14
doc.toc.length;             // 0 —— 没有书签
doc.structure.available;    // true
doc.structure.tagCounts;    // Map { 'Span' => 2253, 'P' => 401, 'Table' => 3, ... }
doc.blocks;                 // 按阅读顺序排好的结构块
doc.pages[3].layout.kind;   // 'single' | 'double' | 'mixed' | 'empty'
doc.pages[3].layout.columnGap; // 303 —— 双栏缝的 x 坐标
doc.headerFooterBands;      // 每页重复出现的 y 带（页眉页脚）
```

## 两个容易踩的坑（都已修，写在这里防止回退）

1. **必须先分栏、再聚行**。反过来的话，左右栏里恰好落在同一基线的两行会被
   合并成一条横跨整页的长行，栏缝的覆盖率被抬起来，缝就找不到了。
   `analyzePage()` 里的顺序不能改。

2. **找「谷底」而不是「低于阈值的区间」**。栏缝处的覆盖率通常不是 0
   （通栏标题、跨栏图会穿过它），所以要在版心中部找最小值点，再向两侧扩展。
   同时要求**两侧都有内容**（`weak-wall` 检查）——只有一侧有内容的那条「缝」
   多半是段落空白，误判成双栏会把一段话劈成两半。

## 命令

```bash
npm run probe      # 打印两份样例模组的统计（页数/书签/标签/版式/重复带）
npm test           # 8 条回归断言，跑在真实模组上
npm run typecheck  # tsc --noEmit
```

注意：`node --test` 必须带 `--test-isolation=none`，否则测试运行器会去
spawn 子进程（沙箱下 EPERM）。

## 还没做的

- 表格结构还原（目前只把 `TR`/`TH`/`TD` 的文本按顺序拼起来，没有还原成二维表）
- 跨页段落拼接（上一页末尾的半个句子 + 下一页开头的半个句子）
- DOCX 路径（`mod-example/` 里没有 docx 样例，完全未验证）
