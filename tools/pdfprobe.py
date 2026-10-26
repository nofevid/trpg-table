"""纯标准库 PDF 结构探针：不依赖任何第三方包。

目的：验证 DESIGN.md §9.2「PDF 版面重建」的可行性 —— 我们需要知道
每页的文本片段坐标、字号、字体，以及矩形（描边框）位置，才谈得上
xy-cut、栏检测、边栏/浮框判定。

不做的事：不还原文字内容（CID 字体需要 ToUnicode CMap，乱码不影响
版面统计）。所以文本只保留长度，不保留字符。

用法：python pdfprobe.py <file.pdf> [--max-pages N]
"""

import re
import sys
import zlib
import collections

# ---------- 基础：对象扫描 ----------

TOKEN_OBJ = re.compile(rb"(\d+)\s+(\d+)\s+obj\b")


def scan_objects(data):
    """暴力扫描 obj/endobj。对象流(ObjStm)里的对象这里看不到，另行处理。"""
    objs = {}
    for m in TOKEN_OBJ.finditer(data):
        num = int(m.group(1))
        start = m.end()
        end = data.find(b"endobj", start)
        if end < 0:
            continue
        objs[num] = data[start:end]
    return objs


def expand_objstm(objs):
    """把 /Type /ObjStm 里压缩的对象解出来，补进 objs。"""
    added = 0
    for body in list(objs.values()):
        if b"/ObjStm" not in body:
            continue
        stream = get_stream(body)
        if not stream:
            continue
        first = re.search(rb"/First\s+(\d+)", body)
        count = re.search(rb"/N\s+(\d+)", body)
        if not (first and count):
            continue
        first = int(first.group(1))
        n = int(count.group(1))
        head = stream[:first].split()
        try:
            pairs = [(int(head[i]), int(head[i + 1])) for i in range(0, min(len(head), n * 2), 2)]
        except (IndexError, ValueError):
            continue
        for idx, (num, off) in enumerate(pairs):
            end = pairs[idx + 1][1] + first if idx + 1 < len(pairs) else len(stream)
            if num not in objs:
                objs[num] = stream[first + off:end]
                added += 1
    return added


def get_stream(body):
    m = re.search(rb"stream\r?\n", body)
    if not m:
        return None
    start = m.end()
    end = body.rfind(b"endstream")
    if end < 0:
        end = len(body)
    raw = body[start:end].rstrip(b"\r\n")
    head = body[: m.start()]
    if b"/FlateDecode" in head:
        try:
            return zlib.decompress(raw)
        except zlib.error:
            try:
                return zlib.decompressobj().decompress(raw)
            except zlib.error:
                return None
    return raw


def deref(objs, body, key):
    """从 body 里取 /Key N 0 R 的 N，返回被引用对象体。"""
    m = re.search(rb"/" + key + rb"\s+(\d+)\s+\d+\s+R", body)
    if not m:
        return None
    return objs.get(int(m.group(1)))


# ---------- 内容流解析 ----------

# 文本状态机：够用来统计"每段文字在哪个坐标、多大字号"
TF = re.compile(rb"/([A-Za-z0-9#\-.+_]+)\s+([\-0-9.]+)\s+Tf")
TM = re.compile(rb"([\-0-9.]+)\s+([\-0-9.]+)\s+([\-0-9.]+)\s+([\-0-9.]+)\s+([\-0-9.]+)\s+([\-0-9.]+)\s+Tm")
TD = re.compile(rb"([\-0-9.]+)\s+([\-0-9.]+)\s+(Td|TD)")
TL = re.compile(rb"([\-0-9.]+)\s+TL")
SHOW_ARR = re.compile(rb"\[(.*?)\]\s*TJ", re.S)
SHOW_STR = re.compile(rb"(\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]*>)\s*Tj", re.S)
RECT = re.compile(rb"([\-0-9.]+)\s+([\-0-9.]+)\s+([\-0-9.]+)\s+([\-0-9.]+)\s+re\b")
STR_IN = re.compile(rb"\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]*>", re.S)


def str_len(tok):
    """估算一个 PDF 字符串 token 的字符数。"""
    if tok.startswith(b"<"):
        hexs = re.sub(rb"\s", b"", tok[1:-1])
        return max(1, len(hexs) // 2)
    s = tok[1:-1]
    # 粗算：\\ 转义算一个字符
    return max(1, len(re.sub(rb"\\[nrtbf()\\]", b"x", s)))


def parse_content(stream):
    """返回 (text_runs, rects)。每条 run: dict(x,y,size,font,n)。"""
    runs = []
    rects = []
    font = None
    size = 0.0
    x = y = 0.0
    lead = 0.0

    for block in re.finditer(rb"BT(.*?)ET", stream, re.S):
        seg = block.group(1)
        # 顺序扫描，维护 x/y
        events = []
        for m in TF.finditer(seg):
            events.append((m.start(), "tf", (m.group(1).decode("latin-1"), float(m.group(2)))))
        for m in TM.finditer(seg):
            events.append((m.start(), "tm", (float(m.group(5)), float(m.group(6)))))
        for m in TD.finditer(seg):
            events.append((m.start(), "td", (float(m.group(1)), float(m.group(2)))))
        for m in TL.finditer(seg):
            events.append((m.start(), "tl", (float(m.group(1)),)))
        for m in SHOW_ARR.finditer(seg):
            items = STR_IN.findall(m.group(1))
            events.append((m.start(), "show", (sum(str_len(t) for t in items), items)))
        for m in SHOW_STR.finditer(seg):
            events.append((m.start(), "show", (str_len(m.group(1)), [m.group(1)])))
        events.sort(key=lambda e: e[0])

        for _, kind, val in events:
            if kind == "tf":
                font, size = val
            elif kind == "tm":
                x, y = val
            elif kind == "td":
                x += val[0]
                y += val[1]
                lead = -val[1] if val[1] != 0 else lead
            elif kind == "tl":
                lead = val[0]
            else:
                n = val[0]
                if n > 0:
                    runs.append({"x": round(x, 1), "y": round(y, 1),
                                 "size": round(size, 1), "font": font, "n": n})
                    # 估算宽度：CJK 约 1em，其余约 0.5em
                    x += size * (1.0 if size else 0.5) * n * 0.5

    for m in RECT.finditer(stream):
        rects.append(tuple(round(float(g), 1) for g in m.groups()))
    return runs, rects


# ---------- 主分析 ----------

def page_boxes(objs, page_body):
    mb = re.search(rb"/MediaBox\s*\[\s*([\-0-9.]+)\s+([\-0-9.]+)\s+([\-0-9.]+)\s+([\-0-9.]+)\s*\]", page_body)
    if mb:
        a, b, c, d = (float(g) for g in mb.groups())
        return c - a, d - b
    return None


def main():
    path = sys.argv[1]
    max_pages = 9999
    if "--max-pages" in sys.argv:
        max_pages = int(sys.argv[sys.argv.index("--max-pages") + 1])

    data = open(path, "rb").read()
    print(f"== {path}")
    print(f"bytes={len(data)}  header={data[:9]!r}")
    print(f"has_ObjStm={b'/ObjStm' in data}  has_XRefStm={b'/XRefStm' in data}  encrypted={b'/Encrypt' in data}")

    objs = scan_objects(data)
    n_added = expand_objstm(objs)
    print(f"objects_scanned={len(objs)} objstm_expanded={n_added}")

    # 页对象
    pages = []
    for num, body in objs.items():
        if re.search(rb"/Type\s*/Page\b", body) and b"/Pages" not in body[:40]:
            pages.append((num, body))
    # 按对象号排序近似阅读顺序
    pages.sort(key=lambda p: p[0])
    print(f"pages_found={len(pages)}")

    # 书签
    outlines = 0
    titles = []
    for body in objs.values():
        if b"/Outlines" in body or b"/Title" in body:
            for t in re.findall(rb"/Title\s*\((?:\\.|[^\\()])*\)", body):
                try:
                    titles.append(t[8:-1].decode("latin-1", "replace"))
                except Exception:
                    pass
    print(f"titles_found={len(titles)}")
    if titles:
        print("first_titles=", titles[:12])

    # 每页统计
    print("\n-- per page --")
    for idx, (num, body) in enumerate(pages[:max_pages]):
        box = page_boxes(objs, body)
        contents = []
        cref = re.search(rb"/Contents\s*(\[.*?\]|\d+\s+\d+\s+R)", body, re.S)
        if cref:
            for rn in re.findall(rb"(\d+)\s+\d+\s+R", cref.group(1)):
                o = objs.get(int(rn))
                if o:
                    s = get_stream(o)
                    if s:
                        contents.append(s)
        if not contents:
            # 直接内联或单引用
            s = get_stream(body)
            if s:
                contents.append(s)
        runs, rects = [], []
        for c in contents:
            r, q = parse_content(c)
            runs += r
            rects += q
        sizes = collections.Counter(round(r["size"], 1) for r in runs)
        xs = [r["x"] for r in runs]
        width = box[0] if box else 0
        # 栏检测：x 起点聚类成 12 桶
        buckets = collections.Counter(int(x / max(width, 1) * 12) if width else 0 for x in xs)
        print(f"p{idx+1} obj={num} box={box} runs={len(runs)} rects={len(rects)} "
              f"sizes={dict(sizes.most_common(5))} xbuckets={dict(sorted(buckets.items()))}")


if __name__ == "__main__":
    main()
