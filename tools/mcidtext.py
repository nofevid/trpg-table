"""按 MCID 提取文本：绕开几何重排，直接用结构树的逻辑顺序。

两份模组都是 Tagged PDF（Catalog 里有 /StructTreeRoot）。结构树里每个
StructElem 的 /K 通过 /MCID 指向内容流里的一段标记内容（BDC ... EMC）。
PDF 规范要求 /K 的顺序就是逻辑阅读顺序 —— 如果这条成立，xy-cut 只需要
在「没有结构树」时兜底。

用法：
  python mcidtext.py <file.pdf> --dump 5          # 第 5 页的 mcid -> 文本
  python mcidtext.py <file.pdf> --order 5 --tags # 第 5 页按结构树顺序输出
"""

import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pdftext import (scan_objects, expand_objstm, get_stream, page_fonts, runs_of)  # noqa: E402


def leaf_mcids(stream):
    """返回 [(mcid, payload)]，只保留最内层标记内容，避免父块重复计入。"""
    out = []
    stack = []
    for m in re.finditer(rb"\b(BDC|BMC|EMC)\b", stream):
        op = m.group(1)
        if op in (b"BDC", b"BMC"):
            head = stream[max(0, m.start() - 400): m.start()]
            mc = re.search(rb"/MCID\s+(\d+)", head)
            stack.append([int(mc.group(1)) if mc else None, m.end(), False])
        elif stack:
            mcid, start, has_child = stack.pop()
            if stack:
                stack[-1][2] = True
            if mcid is not None and not has_child:
                out.append((mcid, stream[start: m.start()]))
    return out


def page_list(objs):
    """按 /Pages /Kids 顺序取页对象编号。"""
    norm = {n: re.sub(rb"\s+", b" ", b) for n, b in objs.items()}
    root = next((n for n, b in norm.items() if re.search(rb"/Type\s*/Pages\b", b) and b"/Parent" not in b), None)
    if root is None:
        pages = [(n, b) for n, b in objs.items() if re.search(rb"/Type\s*/Page\b", b)]
        return [n for n, _ in sorted(pages)]
    order, seen = [], set()

    def walk(oid):
        if oid in seen:
            return
        seen.add(oid)
        body = norm.get(oid, b"")
        kids = re.search(rb"/Kids\s*\[([^\]]*)\]", body)
        if kids:
            for ref in re.findall(rb"(\d+) 0 R", kids.group(1)):
                walk(int(ref))
        elif re.search(rb"/Type\s*/Page\b", body):
            order.append(oid)

    walk(root)
    return order


def build_mcid_text(objs, page_ids, want):
    """{page_index(1-based): {mcid: text}}"""
    result = {}
    for idx, pnum in enumerate(page_ids, 1):
        if idx not in want:
            continue
        body = objs[pnum]
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
        table = {}
        for s in streams:
            for mcid, payload in leaf_mcids(s):
                txt = " ".join(r[4] for r in runs_of(payload, fonts)).strip()
                if txt:
                    table[mcid] = (table.get(mcid, "") + txt).strip()
        result[idx] = table
    return result


def struct_children(objs, norm, oid):
    body = norm.get(oid, b"")
    km = re.search(rb"/K\s*(\[([^\]]*)\]|(\d+) 0 R)", body)
    if not km:
        return []
    if km.group(2) is not None:
        return [int(x) for x in re.findall(rb"(\d+) 0 R", km.group(2))]
    return [int(km.group(3))]


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    path = sys.argv[1]
    dump = int(sys.argv[sys.argv.index("--dump") + 1]) if "--dump" in sys.argv else 0
    order = int(sys.argv[sys.argv.index("--order") + 1]) if "--order" in sys.argv else 0

    data = open(path, "rb").read()
    objs = scan_objects(data)
    expand_objstm(objs)
    norm = {n: re.sub(rb"\s+", b" ", b) for n, b in objs.items()}
    page_ids = page_list(objs)
    print(f"{path}\n页数(pages/kids)={len(page_ids)}")

    want = {dump} if dump else ({order} if order else set())
    texts = build_mcid_text(objs, page_ids, want)

    if dump:
        t = texts.get(dump, {})
        print(f"\n=== p{dump} 叶子 MCID 共 {len(t)} 段 ===")
        for mcid in sorted(t):
            print(f"  [{mcid:>3}] {t[mcid][:80]}")
        return

    if not order:
        print("需要 --dump N 或 --order N")
        return

    cat = next((n for n, b in norm.items() if re.search(rb"/Type\s*/Catalog", b)), None)
    stm = re.search(rb"/StructTreeRoot (\d+) 0 R", norm.get(cat, b""))
    if not stm:
        print("没有 /StructTreeRoot，无法按结构树排序")
        return
    root = int(stm.group(1))
    page_no = {p: i for i, p in enumerate(page_ids, 1)}
    t = texts.get(order, {})

    print(f"\n=== p{order} 按结构树 /K 顺序 ===")
    printed = 0

    def walk(oid, depth=0, path=None):
        nonlocal printed
        path = list(path or [])
        body = norm.get(oid, b"")
        if not body:
            return
        s = re.search(rb"/S\s*/([A-Za-z0-9]+)", body)
        tag = s.group(1).decode() if s else ""
        if tag and tag != "Span":
            path.append(tag)
        pg = re.search(rb"/Pg (\d+) 0 R", body)
        if pg and page_no.get(int(pg.group(1))) == order:
            mcids = []
            # 形式一：/K <</Type/MCR /Pg x 0 R /MCID n>>
            mcids += [int(x) for x in re.findall(rb"/MCID\s+(\d+)", body)]
            # 形式二：/K n（整数 MCID 直接写在元素里，最常见）
            ki = re.search(rb"/K\s+(-?\d+)(?=\s*(?:/|>>|$))", body)
            if ki:
                mcids.append(int(ki.group(1)))
            # 形式三：/K [n m ...]（多个叶子 MCID）
            ka = re.search(rb"/K\s*\[\s*([-\d\s]+)\]", body)
            if ka:
                mcids += [int(x) for x in ka.group(1).split()]
            txt = "".join(t.get(m, "") for m in mcids)
            if txt.strip():
                ctx = ">".join(path[-2:]) or tag
                print(f"  {'  ' * min(depth, 6)}/{tag:<9} [{ctx:<22}] {txt[:70]}")
                printed += 1
        for child in struct_children(objs, norm, oid):
            walk(child, depth + 1, path)

    walk(root)
    print(f"\n共输出 {printed} 段")


if __name__ == "__main__":
    main()
