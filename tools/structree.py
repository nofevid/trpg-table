"""Tagged PDF 结构树（StructTreeRoot）探查。

两份模组的 Catalog 都有 `/StructTreeRoot` + `/MarkInfo <</Marked true>>`，
说明是「标记 PDF」——结构树里带 `/S /H1`、`/S /P` 这类逻辑标签。
如果有，它比字号聚类可靠得多：Word/WPS 导出时标题样式直接变成 H1/H2/P。

用法：python structree.py <file.pdf> [--limit 60]
"""

import os
import re
import sys
import collections

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pdftext import scan_objects, expand_objstm  # noqa: E402


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    path = sys.argv[1]
    limit = int(sys.argv[sys.argv.index("--limit") + 1]) if "--limit" in sys.argv else 60

    data = open(path, "rb").read()
    objs = scan_objects(data)
    expand_objstm(objs)
    norm = {n: re.sub(rb"\s+", b" ", b) for n, b in objs.items()}

    cat = [n for n, b in norm.items() if re.search(rb"/Type\s*/Catalog", b)]
    if not cat:
        print("找不到 Catalog")
        return
    stm = re.search(rb"/StructTreeRoot (\d+) 0 R", norm[cat[0]])
    if not stm:
        print("Catalog 里没有 /StructTreeRoot —— 不是标记 PDF")
        return
    root_id = int(stm.group(1))
    print(f"{path}\nStructTreeRoot = obj {root_id}")

    tags = collections.Counter()
    rows = []
    seen = set()

    def walk(oid, depth=0):
        if oid in seen or len(seen) > 4000:
            return
        seen.add(oid)
        body = norm.get(oid, b"")
        if not body:
            return
        s = re.search(rb"/S\s*/([A-Za-z0-9]+)", body)
        t = re.search(rb"/T\s*\(((?:\\.|[^\\()])*)\)", body)
        if s:
            tags[s.group(1).decode()] += 1
        if s or t:
            rows.append((depth, s.group(1).decode() if s else "", t.group(1).decode("latin-1") if t else "",
                         b"/Pg" in body, b"/K" in body))
        km = re.search(rb"/K\s*(\[|(\d+) 0 R)", body)
        if not km:
            return
        if km.group(1) == b"[":
            arr = re.search(rb"/K\s*\[([^\]]*)\]", body)
            if arr:
                for ref in re.findall(rb"(\d+) 0 R", arr.group(1)):
                    walk(int(ref), depth + 1)
        else:
            walk(int(km.group(2)), depth + 1)

    walk(root_id)

    print(f"\n=== 结构标签直方图（共 {sum(tags.values())} 个元素）===")
    for tag, cnt in tags.most_common(30):
        print(f"  /{tag:<12} {cnt}")

    print(f"\n=== 前 {limit} 个带标签的元素 ===")
    for depth, tag, title, has_pg, has_k in rows[:limit]:
        indent = "  " * min(depth, 6)
        print(f"{indent}/{tag:<10} pg={int(has_pg)} k={int(has_k)}  {title[:50]}")


if __name__ == "__main__":
    main()
