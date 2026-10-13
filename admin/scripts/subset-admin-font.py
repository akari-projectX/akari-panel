#!/usr/bin/env python3
"""
后台字体（2026-10 改版，裁决 admin-redesign-1012 ②：全平台 Inter + Noto Sans SC）。
照门户 spa/scripts/subset-akari-font.py 的做法裁成网页用的小文件（两个应用不共享源码，R23；这里是照抄改写的一份）：

  src/assets/fonts/fonts.css            @font-face 声明（index.css 引入；地址相对它自己，Vite 构建时加哈希）
  src/assets/fonts/inter/latin.*.woff2  Inter 可变字体（字重 300–700、光学尺寸 opsz）拉丁子集：英文、数字、常用符号
  src/assets/fonts/noto/<片>.*.woff2    Noto Sans SC 可变字体（字重 300–700）的汉字与中文标点，按字频切片

原件：
  Inter     node_modules/@fontsource-variable/inter/files/inter-latin-opsz-normal.woff2（npm 依赖，SIL OFL）
  Noto      ../spa/fonts-src/noto/NotoSansSC-VF.woff2（门户仓库里的同一个原件，只读；可用 NOTO_SRC 指定别处）
  常用字    fonts-src/chars.txt（常用 3500 字，从门户拷贝）；切法 scripts/cjk-slices/sc.txt（同上）

收字：界面用字（scripts/collect-text.mjs 从源码字符串统计）+ 常用 3500 字（用户邮箱以外的内容：套餐名、工单、公告）
+ 中文标点 + fonts-src/extra-chars.txt。汉字分「界面用字」「其余常用字」两层，各按字频切片；一个页面只下它用到的那几片。
拉丁字母、数字由 Inter 显示，Noto 不再收拉丁片。

授权：两个字体都是 SIL OFL 1.1，名字表保留授权说明（13/14），全文随产物分发于 assets/licenses/。

重新运行（改了界面中文文案、extra-chars.txt 或换了原件之后）：
  <装了 fonttools + brotli 的 python> scripts/subset-admin-font.py
"""
import hashlib, json, os, pathlib, shutil, subprocess, tempfile
from concurrent.futures import ProcessPoolExecutor

from fontTools.ttLib import TTFont
from fontTools import subset as ftsubset
from fontTools.varLib import instancer

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / 'fonts-src'
NOTO = pathlib.Path(os.environ.get('NOTO_SRC', ROOT.parent / 'spa/fonts-src/noto/NotoSansSC-VF.woff2'))
INTER = ROOT / 'node_modules/@fontsource-variable/inter/files/inter-latin-opsz-normal.woff2'
SLICES = ROOT / 'scripts/cjk-slices/sc.txt'
OUT = ROOT / 'src/assets/fonts'
LICENSES = ROOT / 'public/assets/licenses'

# 网页字体的家族名不和本机字体重名：@font-face 声明的家族会遮住同名的本机字体（门户同样的考虑）
INTER_FAMILY = 'Inter Akari'
NOTO_FAMILY = 'Noto Sans SC Akari'
WGHT = (300, 700)
SCRIPTS = ['DFLT', 'cyrl', 'grek', 'hani', 'kana', 'latn']
VERTICAL = ['vert', 'vrt2', 'valt', 'vkrn', 'vpal', 'vhal']
DROP_TABLES = ['vhea', 'vmtx', 'VORG', 'meta']


def span(a: int, b: int) -> set[int]:
    return set(range(a, b + 1))


HAN_PUNCT = span(0x3000, 0x303f) | span(0xff00, 0xffef) | span(0x2010, 0x2027) | span(0x2030, 0x2033) | {0xb7}
# Inter 的拉丁片：与 fontsource / Google Fonts 的 latin 分片同一口径，再加上箭头
LATIN = (span(0x20, 0x7e) | span(0xa0, 0xff) | {0x131, 0x152, 0x153, 0x2bb, 0x2bc, 0x2c6, 0x2da, 0x2dc, 0x304, 0x308, 0x329}
         | span(0x2000, 0x206f) | {0x20ac, 0x2122, 0x2212, 0x2215, 0xfeff, 0xfffd} | span(0x2190, 0x21ff))


def expand(rng: str) -> set[int]:
    cps: set[int] = set()
    for part in rng.split(','):
        part = part.strip().lower().removeprefix('u+')
        if '-' in part:
            a, b = part.split('-')
            cps |= span(int(a, 16), int(b, 16))
        elif part:
            cps.add(int(part, 16))
    return cps


def to_ranges(cps: list[int]) -> str:
    out, i = [], 0
    while i < len(cps):
        j = i
        while j + 1 < len(cps) and cps[j + 1] == cps[j] + 1:
            j += 1
        out.append(f'U+{cps[i]:x}' if i == j else f'U+{cps[i]:x}-{cps[j]:x}')
        i = j + 1
    return ','.join(out)


def slices() -> list[tuple[str, set[int]]]:
    rows = []
    for line in SLICES.read_text(encoding='utf-8').splitlines():
        if line and not line.startswith('#'):
            idx, rng = line.split('\t')
            rows.append((idx, expand(rng)))
    return rows


def ui_text() -> set[int]:
    out = subprocess.run(['node', str(ROOT / 'scripts/collect-text.mjs')],
                         check=True, capture_output=True, text=True, cwd=ROOT).stdout
    return {ord(c) for c in json.loads(out)['sc']}


def options(extra_features: list[str]) -> ftsubset.Options:
    opts = ftsubset.Options()
    opts.layout_features = [f for f in opts.layout_features if f not in VERTICAL] + extra_features
    opts.name_IDs = [*opts.name_IDs, 13, 14]
    opts.layout_scripts = [f'{s}.dflt' for s in SCRIPTS]
    opts.drop_tables += DROP_TABLES
    return opts


# Inter：表格数字（tnum）、斜杠零以外的字形变体（cv11 单层 a、ss01 开放数字）要留着，index.css 用到
INTER_FEATURES = ['tnum', 'cv11', 'ss01', 'case', 'zero']
NOTO_FEATURES = ['pwid']


def trim(src: str, dst: str, cps: list[int], axes: dict, features: list[str]) -> str:
    font = TTFont(src)
    sub = ftsubset.Subsetter(options(features))
    sub.populate(unicodes=cps)
    sub.subset(font)
    font = instancer.instantiateVariableFont(font, axes)
    font.flavor = None
    font.save(dst)
    return dst


def slice_font(job: tuple[str, str, list[int], list[str]]) -> tuple[str, list[int], int]:
    src, dst, cps, features = job
    font = TTFont(src)
    sub = ftsubset.Subsetter(options(features))
    sub.populate(unicodes=cps)
    sub.subset(font)
    have = sorted((font.getBestCmap() or {}).keys())
    if not have:
        return dst, [], 0
    path = pathlib.Path(dst)
    path.parent.mkdir(parents=True, exist_ok=True)
    font.flavor = 'woff2'
    font.save(path)
    final = path.with_name(f'{path.stem}.{hashlib.sha1(path.read_bytes()).hexdigest()[:8]}.woff2')
    path.rename(final)
    return str(final), have, final.stat().st_size


def face(family: str, url: str, cps: list[int]) -> str:
    return (
        f'@font-face {{\n'
        f'  font-family: "{family}";\n'
        f'  font-style: normal;\n'
        f'  font-display: swap;\n'
        f'  font-weight: {WGHT[0]} {WGHT[1]};\n'
        f'  src: url("./{url}") format("woff2");\n'
        f'  unicode-range: {to_ranges(cps)};\n'
        f'}}')


def main() -> int:
    ui = ui_text()
    common = {ord(c) for c in (SRC / 'chars.txt').read_text(encoding='utf-8') if not c.isspace()}
    extra_file = SRC / 'extra-chars.txt'
    extra = {ord(c) for c in extra_file.read_text(encoding='utf-8') if not c.isspace()} if extra_file.exists() else set()
    have = set(TTFont(NOTO).getBestCmap())
    han = have & (common | ui | extra | HAN_PUNCT) - LATIN

    if OUT.exists():
        shutil.rmtree(OUT)

    with tempfile.TemporaryDirectory() as tmp, ProcessPoolExecutor() as pool:
        inter = pool.submit(trim, str(INTER), f'{tmp}/inter.ttf', sorted(LATIN), {'wght': WGHT}, INTER_FEATURES)
        noto = pool.submit(trim, str(NOTO), f'{tmp}/noto.ttf', sorted(han), {'wght': WGHT}, NOTO_FEATURES)
        jobs = [(inter.result(), str(OUT / 'inter' / 'latin.woff2'), sorted(LATIN), INTER_FEATURES)]
        rows = slices()
        sliced = set().union(*(cps for _, cps in rows))
        for prefix, tier in [('', han & ui), ('x', han - ui)]:
            jobs += [(noto.result(), str(OUT / 'noto' / f'{prefix}{idx}.woff2'), sorted(tier & cps), NOTO_FEATURES)
                     for idx, cps in [*rows, ('z', han - sliced)] if tier & cps]
        results = list(pool.map(slice_font, jobs))

    rules = []
    for dst, got, _ in results:
        if not got:
            continue
        rel = pathlib.Path(dst).relative_to(OUT).as_posix()
        rules.append(face(INTER_FAMILY if rel.startswith('inter/') else NOTO_FAMILY, rel, got))
    LICENSES.mkdir(parents=True, exist_ok=True)
    shutil.copy(SRC / 'Noto-OFL.txt', LICENSES / 'NotoSansSC-OFL.txt')
    shutil.copy(INTER.parent.parent / 'LICENSE', LICENSES / 'Inter-OFL.txt')
    css = OUT / 'fonts.css'
    css.write_text(
        '/*\n'
        ' * 由 scripts/subset-admin-font.py 生成，请勿手改。index.css 引入。\n'
        f' * {INTER_FAMILY}：Inter 拉丁子集；{NOTO_FAMILY}：Noto Sans SC 汉字与中文标点（界面用字 + 常用 3500 字）。\n'
        ' */\n'
        + '\n'.join(rules) + '\n', encoding='utf-8')

    total = sum(n for _, got, n in results if got)
    inter_kb = next(n for d, got, n in results if '/inter/' in d) / 1024
    print(f'Inter latin {inter_kb:.0f} kB；Noto {len(han)} 字 {(total / 1024) - inter_kb:.0f} kB；'
          f'{len(rules)} 条 @font-face，合计 {total / 1024 / 1024:.2f} MB')
    miss = sorted(u for u in ui - have - LATIN if 0x3000 <= u <= 0x9fff or 0xff00 <= u <= 0xffef)
    if miss:
        print(f'  界面用到、字体里没有的字（{len(miss)}）：{"".join(map(chr, miss))}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
