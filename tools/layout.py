"""版面结构判定 v3：按行的左端 x0 聚类判定栏结构。

v1/v2 都栽在同一件事上：这份模组的左右栏是两条独立文本流，基线互相错开，
同一 y 上通常只有一栏的内容，所以「行内 gap」几乎检不到栏缝。
真正稳定的信号是「每行从哪个 x 开始」——正文双栏时它会分裂成两个簇。

判据（对应 DESIGN.md §9.2 (3)）：
- 行左端 x0 排序后按 <=20pt 归簇，相邻簇中心差 <=40pt 合并
- 双栏：两簇各 >= 20% 的行，中心差 > 150pt
- 多块：>= 3 个有效簇（表格页/信息框页）
- 单栏：一簇占 >= 70%
- 混合：其余

用法：python layout.py <file.pdf>
"""

import os
import re
import sys
import collections

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pdftext import scan_objects, expand_objstm, get_stream, page_fonts, runs_of  # noqa: E402

CJK_PUNCT = "，。、；：？！“”‘’（）《》〈〉—…·「」【】"


def text_width(text, size):
    return sum(size if ("\u4e00" <= ch <= "\u9fff" or ch in CJK_PUNCT) else size * 0.5 for ch in text)


def cluster_rows(runs, tol=3.0):
    rows = []
    for y, x, size, font, text in sorted(runs, key=lambda r: (-r[0], r[1])):
        seg = (x, x + text_width(text, size))
        if rows and abs(rows[-1]["y"] - y) <= tol:
            rows[-1]["segs"].append(seg)
        else:
            rows.append({"y": y, "segs": [seg], "size": size})
    for r in rows:
        segs = sorted(r["segs"])
        merged = [list(segs[0])]
        for a, b in segs[1:]:
            if a <= merged[-1][1] + 1.0:
                merged[-1][1] = max(merged[-1][1], b)
            else:
                merged.append([a, b])
        r["merged"] = merged
        r["x0"] = merged[0][0]
        r["x1"] = merged[-1][1]
    return rows


def cluster_1d(values, gap=20.0, merge=40.0, min_size=2):
    vals = sorted(values)
    if not vals:
        return []
    groups = [[vals[0]]]
    for v in vals[1:]:
        if v - groups[-1][-1] <= gap:
            groups[-1].append(v)
        else:
            groups.append([v])
    out = []
    for g in groups:
        c = sum(g) / len(g)
        if out and c - out[-1][0] < merge:
            out[-1][1].extend(g)
            out[-1][0] = sum(out[-1][1]) / len(out[-1][1])
        else:
            out.append([c, list(g)])
    return [(c, len(g)) for c, g in out if len(g) >= min_size]


def classify(rows):
    total = len(rows)
    if not total:
        return "空白", []
    cols = cluster_1d([r["x0"] for r in rows])
    if not cols:
        return "单栏", [(rows[0]["x0"], total)]
    big = [(c, n) for c, n in cols if n >= max(2, total * 0.06)]
    if len(big) >= 3:
        return "多块", big
    if len(big) == 2:
        (c1, n1), (c2, n2) = big[0], big[1]
        if c2 - c1 > 150 and n1 >= total * 0.20 and n2 >= total * 0.20:
            return "双栏", big
    if big and big[0][1] >= total * 0.70:
        return "单栏", big
    return "混合", big


def page_media(objs, body):
    mb = re.search(rb"/MediaBox\s*\[\s*([\-0-9.]+)\s+([\-0-9.]+)\s+([\-0-9.]+)\s+([\-0-9.]+)\s*\]", body)
    if not mb:
        return 0, 0, 595.0, 842.0
    return tuple(float(g) for g in mb.groups())


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    path = sys.argv[1]
    data = open(path, "rb").read()
    objs = scan_objects(data)
    expand_objstm(objs)
    pages = [(n, b) for n, b in objs.items()
             if re.search(rb"/Type\s*/Page\b", b) and b"/Pages" not in b[:40]]
    pages.sort(key=lambda p: p[0])
    print(f"{path}\npages={len(pages)}\n")

    tally = collections.Counter()
    rows_out = []
    for idx, (num, body) in enumerate(pages, 1):
        x0, y0, x1, y1 = page_media(objs, body)
        fonts = page_fonts(objs, body)
        streams = []
        cm = re.search(rb"/Contents\s*(\[.*?\]|\d+\s+\d+\s+R)", body, re.S)
        if cm:
            for rn in re.findall(rb"(\d+)\s+\d+\s+R", cm.group(1)):
                o = objs.get(int(rn))
                if o:
                    s = get_stream(o)
                    if s:
                        streams.append(s)
        runs = []
        for s in streams:
            runs += runs_of(s, fonts)
        runs = [r for r in runs if y0 + 0.06 * (y1 - y0) < r[0] < y1 - 0.05 * (y1 - y0)]
        rows = cluster_rows(runs)
        kind, cols = classify(rows)
        tally[kind] += 1
        colinfo = " ".join(f"x≈{c:.0f}({n})" for c, n in cols)
        print(f"p{idx:<3} {kind:<4} rows={len(rows):<3} 簇: {colinfo}")
        rows_out.append((idx, kind, len(rows), cols))

    print("\n-- 汇总 --")
    for k, v in tally.items():
        print(f"  {k}: {v} 页")
    for idx, kind, n, cols in rows_out:
        if kind in ("双栏", "多块", "混合"):
            print(f"  p{idx} {kind}: " + " ".join(f"x≈{c:.0f}({cnt})" for c, cnt in cols))


if __name__ == "__main__":
    main()
