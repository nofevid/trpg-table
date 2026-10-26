"""带文字还原的 PDF 版面探针：解析 ToUnicode，输出每个文本块的坐标与文字。

目的：确认 §9.2 的两个前提在真实模组上成立 ——
1) 有可用文本层（不是扫描件）；
2) 中文能通过 ToUnicode 还原（Identity-H 子集字体也能还原）。

输出按阅读顺序不排序，只按内容流顺序，便于对照原页。

用法：python pdftext.py <file.pdf> [--pages 1-3] [--limit 40]
"""

import re
import sys
import zlib

TOKEN_OBJ = re.compile(rb"(\d+)\s+(\d+)\s+obj\b")


def scan_objects(data):
    objs = {}
    for m in TOKEN_OBJ.finditer(data):
        num = int(m.group(1))
        start = m.end()
        end = data.find(b"endobj", start)
        if end > 0:
            objs[num] = data[start:end]
    return objs


def get_stream(body):
    m = re.search(rb"stream\r?\n", body)
    if not m:
        return None
    raw = body[m.end(): body.rfind(b"endstream")].rstrip(b"\r\n")
    return zlib.decompress(raw) if b"/FlateDecode" in body[: m.start()] else raw


def expand_objstm(objs):
    for body in list(objs.values()):
        if b"/ObjStm" not in body:
            continue
        stream = get_stream(body)
        f = re.search(rb"/First\s+(\d+)", body)
        n = re.search(rb"/N\s+(\d+)", body)
        if not (stream and f and n):
            continue
        first, count = int(f.group(1)), int(n.group(1))
        head = stream[:first].split()
        try:
            pairs = [(int(head[i]), int(head[i + 1])) for i in range(0, min(len(head), count * 2), 2)]
        except (IndexError, ValueError):
            continue
        for i, (num, off) in enumerate(pairs):
            end = pairs[i + 1][1] + first if i + 1 < len(pairs) else len(stream)
            objs.setdefault(num, stream[first + off: end])


def deref(objs, body, key):
    m = re.search(rb"/" + key + rb"\s+(\d+)\s+\d+\s+R", body)
    return objs.get(int(m.group(1))) if m else None


def parse_tounicode(stream):
    m = {}
    for blk in re.findall(rb"beginbfchar(.*?)endbfchar", stream, re.S):
        for a, b in re.findall(rb"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>", blk):
            try:
                m[int(a, 16)] = bytes.fromhex(b.decode()).decode("utf-16-be", "replace")
            except ValueError:
                pass
    for blk in re.findall(rb"beginbfrange(.*?)endbfrange", stream, re.S):
        # 数组形式：<lo> <hi> [<u1> <u2> ...]，必须单独处理，否则整段缺字
        for a, b, arr in re.findall(rb"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[(.*?)\]", blk, re.S):
            lo = int(a, 16)
            for i, u in enumerate(re.findall(rb"<([0-9A-Fa-f]+)>", arr)):
                try:
                    m[lo + i] = bytes.fromhex(u.decode()).decode("utf-16-be", "replace")
                except ValueError:
                    pass
        for a, b, c in re.findall(rb"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>", blk):
            lo, hi, base = int(a, 16), int(b, 16), int(c, 16)
            for i in range(min(hi - lo + 1, 65535)):
                try:
                    m[lo + i] = chr(base + i)
                except ValueError:
                    pass
    return m


def page_fonts(objs, page_body):
    """返回 {资源名: (宽度字节数, 映射表)}"""
    res = deref(objs, page_body, b"Resources") or page_body
    fonts = {}
    fd = re.search(rb"/Font\s*<<(.*?)>>", res, re.S)
    if not fd:
        fref = re.search(rb"/Font\s+(\d+)\s+\d+\s+R", res)
        if fref:
            sub = objs.get(int(fref.group(1)), b"")
            fd = re.search(rb"<<(.*?)>>", sub, re.S)
    if not fd:
        return fonts
    for name, num in re.findall(rb"/([A-Za-z0-9]+)\s+(\d+)\s+\d+\s+R", fd.group(1)):
        fobj = objs.get(int(num), b"")
        two_byte = b"/Type0" in fobj or b"Identity-H" in fobj
        tu = deref(objs, fobj, b"ToUnicode")
        cmap = parse_tounicode(get_stream(tu) or b"") if tu else {}
        em = re.search(rb"/Encoding\s*/([A-Za-z0-9\-]+)", fobj)
        enc = em.group(1).decode() if em else ""
        fonts[name.decode()] = (2 if two_byte else 1, cmap, enc)
    return fonts


def decode(tok, width, cmap, enc=""):
    if tok.startswith(b"<"):
        hexs = re.sub(rb"\s", b"", tok[1:-1])
        raw = bytes.fromhex(hexs.decode() if len(hexs) % 2 == 0 else hexs.decode() + "0")
    else:
        raw = tok[1:-1]
    if width == 2 and (enc.startswith("GBK") or enc.startswith("GB-EUC")):
        return raw.decode("gbk", "replace")
    if width == 2 and enc.startswith("UniGB"):
        return raw.decode("utf-16-be", "replace")
    out = []
    if width == 2:
        for i in range(0, len(raw) - 1, 2):
            cid = (raw[i] << 8) | raw[i + 1]
            out.append(cmap.get(cid, "\ufffd"))
    else:
        for b in raw:
            out.append(cmap.get(b, chr(b) if 32 <= b < 127 else "\ufffd"))
    return "".join(out)


TF = re.compile(rb"/([A-Za-z0-9]+)\s+([\-0-9.]+)\s+Tf")
TM = re.compile(rb"([\-0-9.]+)\s+([\-0-9.]+)\s+([\-0-9.]+)\s+([\-0-9.]+)\s+([\-0-9.]+)\s+([\-0-9.]+)\s+Tm")
TD = re.compile(rb"([\-0-9.]+)\s+([\-0-9.]+)\s+(Td|TD)")
SHOW = re.compile(rb"(\[[^\]]*\]\s*TJ|\((?:\\.|[^\\()])*\)\s*Tj|<[0-9A-Fa-f\s]*>\s*Tj)", re.S)
STR_IN = re.compile(rb"\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]*>", re.S)


def runs_of(stream, fonts):
    runs = []
    for block in re.finditer(rb"BT(.*?)ET", stream, re.S):
        seg, x, y, size, font = block.group(1), 0.0, 0.0, 0.0, None
        events = []
        for m in TF.finditer(seg):
            events.append((m.start(), "tf", (m.group(1).decode(), float(m.group(2)))))
        for m in TM.finditer(seg):
            events.append((m.start(), "tm", (float(m.group(5)), float(m.group(6)))))
        for m in TD.finditer(seg):
            events.append((m.start(), "td", (float(m.group(1)), float(m.group(2)))))
        for m in SHOW.finditer(seg):
            events.append((m.start(), "show", m.group(1)))
        events.sort(key=lambda e: e[0])
        for _, kind, val in events:
            if kind == "tf":
                font, size = val
            elif kind == "tm":
                x, y = val
            elif kind == "td":
                x += val[0]
                y += val[1]
            else:
                width, cmap, enc = fonts.get(font, (1, {}, ""))
                toks = STR_IN.findall(val)
                text = "".join(decode(t, width, cmap, enc) for t in toks)
                if text.strip():
                    runs.append((round(y, 1), round(x, 1), round(size, 1), font, text))
                    x += size * 0.5 * sum(len(t) for t in toks)
    return runs


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    path = sys.argv[1]
    lo, hi, limit = 1, 9999, 40
    if "--pages" in sys.argv:
        a, b = sys.argv[sys.argv.index("--pages") + 1].split("-")
        lo, hi = int(a), int(b)
    if "--limit" in sys.argv:
        limit = int(sys.argv[sys.argv.index("--limit") + 1])

    data = open(path, "rb").read()
    objs = scan_objects(data)
    expand_objstm(objs)

    pages = [(n, b) for n, b in objs.items()
             if re.search(rb"/Type\s*/Page\b", b) and b"/Pages" not in b[:40]]
    pages.sort(key=lambda p: p[0])
    print(f"{path}: pages={len(pages)}")

    for idx, (num, body) in enumerate(pages, 1):
        if not (lo <= idx <= hi):
            continue
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
        cjk = sum(1 for r in runs if re.search(r"[\u4e00-\u9fff]", r[4]))
        print(f"\n== p{idx} fonts={ {k: (v[0], len(v[1])) for k, v in fonts.items()} } runs={len(runs)} cjk_runs={cjk}")
        for y, x, size, font, text in runs[:limit]:
            print(f"  y={y:>7} x={x:>7} sz={size:>5} {font} {text[:60]}")


if __name__ == "__main__":
    main()
