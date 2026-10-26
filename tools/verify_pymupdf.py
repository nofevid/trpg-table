"""用 PyMuPDF 做权威验证，对照 tools/ 里手写解析器的结论。

重点复核三件事：
1. 书签 —— 手写的 outline.py 只扫了未压缩的 `N 0 obj`，没有展开对象流，
   若 Outline 树在 ObjStm 里就会漏。`doc.get_toc()` 是权威答案。
2. 文字还原 —— 是否与手写 ToUnicode 解析一致、有无缺字。
3. 版面与表格 —— `get_text("dict")` 的 block bbox 与 `find_tables()`。

用法：python verify_pymupdf.py <file.pdf> [--tables] [--sample 页码]
"""

import sys
import collections

import pymupdf


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    path = sys.argv[1]
    show_tables = "--tables" in sys.argv
    sample = int(sys.argv[sys.argv.index("--sample") + 1]) if "--sample" in sys.argv else 0

    doc = pymupdf.open(path)
    print(f"{path}")
    print(f"pages={doc.page_count}  encrypted={doc.is_encrypted}  "
          f"metadata.title={doc.metadata.get('title')!r}")
    print(f"page size = {doc[0].rect.width:.1f} x {doc[0].rect.height:.1f}")

    toc = doc.get_toc(simple=True)
    print(f"\n=== 书签 get_toc() 条目数 = {len(toc)} ===")
    for lvl, title, pno in toc[:50]:
        print(f"  L{lvl}  p{pno:<3} {title}")

    sizes = collections.Counter()
    tables_total = 0
    print("\n=== 逐页结构 ===")
    for i, page in enumerate(doc, 1):
        d = page.get_text("dict")
        tblocks = [b for b in d["blocks"] if b["type"] == 0]
        for b in tblocks:
            for line in b["lines"]:
                for span in line["spans"]:
                    sizes[round(span["size"], 1)] += len(span["text"].strip())
        nt = 0
        try:
            tabs = page.find_tables()
            nt = len(tabs.tables)
            if show_tables:
                for t in tabs.tables[:3]:
                    print(f"    [p{i} table] rows={t.row_count} cols={t.col_count} bbox={tuple(round(v) for v in t.bbox)}")
                    for row in t.extract()[:3]:
                        print("      " + " | ".join((c or "").replace("\n", " ")[:18] for c in row))
        except Exception as exc:
            print(f"    find_tables 不可用: {exc}")
        tables_total += nt
        xs = [round(b["bbox"][0]) for b in tblocks]
        print(f"p{i:<3} blocks={len(tblocks):<3} tables={nt:<2} block_x0 前几位={xs[:6]}")

    print("\n=== 字号直方图（按字符数，前 12）===")
    for size, cnt in sizes.most_common(12):
        print(f"  {size:>5.1f}pt  {cnt:>6} 字")

    print(f"\n检测到表格总数 = {tables_total}")

    if sample:
        page = doc[sample - 1]
        print(f"\n=== 第 {sample} 页文本（PyMuPDF 直接还原，前 40 行）===")
        for line in page.get_text("text").splitlines()[:40]:
            if line.strip():
                print("  " + line)


if __name__ == "__main__":
    main()
