"""逐行转储：打印一页里每一行的文本段区间与文字，用于肉眼判断栏结构。

用法：python rowdump.py <file.pdf> <页码> [--max 40]
"""

import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pdftext import scan_objects, expand_objstm, get_stream, page_fonts, runs_of  # noqa: E402
from layout import text_width, cluster_rows, classify  # noqa: E402


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    path, page = sys.argv[1], int(sys.argv[2])
    mx = int(sys.argv[sys.argv.index("--max") + 1]) if "--max" in sys.argv else 60

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

    rows = cluster_rows(runs)
    kind, cols = classify(rows)
    print(f"p{page}: rows={len(rows)} {kind} 簇={[f'{c:.0f}({n})' for c, n in cols]}\n")
    for r in rows[:mx]:
        segs = " | ".join(f"[{a:.0f},{b:.0f}]" for a, b in r["merged"])
        print(f"y={r['y']:>6.1f} sz={r['size']:>4.1f} {segs}")
        for a, b in r["merged"]:
            txt = "".join(t for y, x, s, f, t in runs
                          if abs(y - r["y"]) <= 1.5 and a - 1 <= x <= b + 1)
            print(f"      {txt[:70]}")


if __name__ == "__main__":
    main()
