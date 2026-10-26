"""书签（PDF Outline）检查：判断「书签优先」这条策略在真实模组上是否可用。

用法：python outline.py <file.pdf>
"""

import re
import sys


def decode_pdf_string(raw):
    if raw.startswith(b"\xfe\xff"):
        return raw[2:].decode("utf-16-be", "replace")
    if raw.startswith(b"\xff\xfe"):
        return raw[2:].decode("utf-16-le", "replace")
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("latin-1", "replace")


def read_pdf_string(data, i):
    """i 指向 '(' 或 '<' 之后的位置，返回 (bytes, 结束位置)。"""
    if data[i - 1 : i] == b"<":
        end = data.find(b">", i)
        hexs = re.sub(rb"\s", b"", data[i:end])
        return bytes.fromhex(hexs.decode()), end + 1
    out, depth = bytearray(), 1
    while i < len(data):
        c = data[i]
        if c == 0x5C:  # backslash
            nxt = data[i + 1 : i + 2]
            mapping = {b"n": b"\n", b"r": b"\r", b"t": b"\t", b"b": b"\b", b"f": b"\f"}
            if nxt in mapping:
                out += mapping[nxt]
                i += 2
                continue
            if nxt.isdigit():
                j = i + 1
                oct_digits = b""
                while j < len(data) and len(oct_digits) < 3 and data[j : j + 1].isdigit():
                    oct_digits += data[j : j + 1]
                    j += 1
                out.append(int(oct_digits, 8) & 0xFF)
                i = j
                continue
            out += nxt
            i += 2
            continue
        if c == 0x28:
            depth += 1
        elif c == 0x29:
            depth -= 1
            if depth == 0:
                return bytes(out), i + 1
        out.append(c)
        i += 1
    return bytes(out), i


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    path = sys.argv[1]
    data = open(path, "rb").read()

    # 关键修正：必须展开对象流再找，否则压缩在 ObjStm 里的 Outline 树会被漏掉
    from pdftext import scan_objects, expand_objstm
    objs = scan_objects(data)
    expand_objstm(objs)

    norm = {n: re.sub(rb"\s+", b" ", b) for n, b in objs.items()}
    outline_objs = [n for n, b in norm.items() if re.search(rb"/Type\s*/Outlines", b)]
    catalog = [n for n, b in norm.items() if re.search(rb"/Type\s*/Catalog", b)]
    print(f"{path}")
    print(f"展开后对象数={len(objs)}  /Type /Outlines 对象={outline_objs}  Catalog={catalog}")
    if catalog:
        cat = norm[catalog[0]]
        m = re.search(rb"/Outlines (\d+) 0 R", cat)
        print(f"Catalog 里的 /Outlines 引用: {m.group(1).decode() if m else '（无）'}")
        print(f"Catalog 片段: {cat[:260]!r}")

    titles = []
    for n, body in objs.items():
        for m in re.finditer(rb"/Title\s*(\(|<)", body):
            raw, _ = read_pdf_string(body, m.end())
            titles.append((n, decode_pdf_string(raw), b"/Parent" in body, b"/Dest" in body))

    print(f"\n/Title 共 {len(titles)} 处（展开后）")
    for n, t, has_parent, has_dest in titles[:40]:
        print(f"  obj {n:<6} parent={int(has_parent)} dest={int(has_dest)}  {t}")

    real = [x for x in titles if x[2] or x[3]]
    print(f"\n看起来像书签条目（有 /Parent 或 /Dest）的 = {len(real)} 条")
    for n, t, _, _ in real[:40]:
        print(f"  obj {n:<6} {t}")

    # 兜底：裸扫（不展开）也会命中的情况
    print(f"\n裸扫 /Outlines 出现 = {data.count(b'/Outlines')} 次")


if __name__ == "__main__":
    main()
