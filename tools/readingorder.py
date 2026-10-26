"""阅读顺序还原 v2：先用「x 覆盖为真空带」找栏缝，再按 run 起点分栏，再栏内聚行。

v1 的错误：用「文字块中心 x」判断归属，长行中心会越过栏缝，导致一行文字被劈开。
正确做法：栏缝位置由全页 x 覆盖统计得出，然后按每个文本块的**起点 x** 归属。

用法：python readingorder.py <file.pdf> <页码> [--width 80]
"""

import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pdftext import scan_objects, expand_objstm, get_stream, page_fonts, runs_of  # noqa: E402
from layout import text_width, cluster_rows  # noqa: E402


def find_gutter(runs, lo=20, hi=590, tol=0.05, min_w=5):
    cover = {}
    for y, x, size, font, text in runs:
        a, b = int(x), int(round(x + text_width(text, size)))
        for i in range(a, b):
            cover[i] = cover.get(i, 0) + 1
    thr = max(1, int(tol * len(runs)))
    gaps, cur = [], None
    for i in range(lo, hi):
        if cover.get(i, 0) <= thr:
            cur = [i, i] if cur is None else [cur[0], i]
        else:
            if cur:
                gaps.append(tuple(cur))
            cur = None
    if cur:
        gaps.append(tuple(cur))
    wide = [g for g in gaps if g[1] - g[0] >= min_w and lo + 0.15 * (hi - lo) < (g[0] + g[1]) / 2 < lo + 0.85 * (hi - lo)]
    return max(wide, key=lambda g: g[1] - g[0]) if wide else None


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    path, page = sys.argv[1], int(sys.argv[2])
    width = int(sys.argv[sys.argv.index("--width") + 1]) if "--width" in sys.argv else 80

    data = open(path, "rb").read()
    objs = scan_objects(data)
    expand_objstm(objs)
    pages = [(n, b) for n, b in objs.items()
             if re.search(rb"/Type\s*/Page\b", b) and b"/Pages" not in b[:40]]
    pages.sort(key=lambda p: p[0])
    num, body = pages[page - 1]
    fonts = page_fonts(objs, body)
    cm = re.search(rb"/Contents\s*(\[.*?\]|\d+\s+\d+\s+R)", body, re.S)
    runs = []
    for rn in re.findall(rb"(\d+)\s+\d+\s+R", cm.group(1)):
        o = objs.get(int(rn))
        if o:
            s = get_stream(o)
            if s:
                runs += runs_of(s, fonts)
    runs = [r for r in runs if 60 < r[0] < 790]

    gutter = find_gutter(runs)
    print(f"p{page}: 栏缝={gutter}\n")

    if not gutter:
        groups = [runs]
        labels = ["全宽"]
    else:
        g = (gutter[0] + gutter[1]) / 2
        groups = [[r for r in runs if r[1] < g], [r for r in runs if r[1] >= g]]
        labels = ["左栏", "右栏"]

    for label, grp in zip(labels, groups):
        if not grp:
            continue
        print(f"===== {label} =====  (x 范围 {min(r[1] for r in grp):.0f}–{max(r[1] for r in grp):.0f})")
        rows = cluster_rows(grp)
        for r in sorted(rows, key=lambda r: -r["y"]):
            seg = "".join(t for y, x, s, f, t in sorted(grp, key=lambda z: z[1]) if abs(y - r["y"]) <= 1.5)
            if seg.strip():
                print(seg[:width])
        print()


if __name__ == "__main__":
    main()
