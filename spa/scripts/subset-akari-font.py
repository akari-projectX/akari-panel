#!/usr/bin/env python3
"""
把站点的正文字体 Noto Sans SC 裁成网页用的小文件，连同字体声明一起放进 src/assets/fonts/：
  akari.css                  @font-face 声明，字体地址是相对它自己的
  noto/latin.3fa9c1d2.woff2  英文、数字、常用符号（每个页面都用）
  noto/ext.3fa9c1d2.woff2    带变音符的拉丁字母、希腊、西里尔（内容里真出现才下载）
  noto/22.3fa9c1d2.woff2     汉字的字频切片；文件名都带内容哈希

全平台、中英文都用这一款：苹果设备也一样，不再按设备换成系统字体（见 src/index.css「字体栈」）。

原件：
  fonts-src/noto/NotoSansSC-VF.woff2     Google Fonts 官方仓库的 Noto Sans SC 可变字体（字重 100–900，
                                         SIL OFL 授权，见同目录 OFL.txt；由 NotoSansSC[wght].ttf 无损转成 woff2）
  fonts-src/akari/chars.txt              常用 3500 字

── 收哪些字 ──
  · 英文、数字、拉丁字母和常用符号：字体里有的都收；
  · 常用 3500 字（chars.txt）：公告、文档、套餐名这类后台写的内容，绝大多数字都在里面；
  · 界面用到的字：scripts/collect-text.mjs 从源码的字符串里统计（注释不算），常用字表以外的也收；
  · fonts-src/akari/extra-chars.txt：站长想用网页字体显示、却不在上面几份里的字；
  · 中文标点：全角标点、引号破折号省略号这些，后台文章里随处都是。
  其余的字先找本机装的 Noto Sans SC，再落到苹方 / 微软雅黑。
  汉字按「界面用字」「其余常用字」分两层，各自按字频切片（切法见 scripts/cjk-slices/sc.txt，借的是 Google Fonts 的中文分片），
  一个页面只下它用到的那几片；只显示界面文案的页面碰不到第二层。unicode-range 按裁完**实际存在的字形**写，浏览器不会为字体里没有的字白下一个文件。

── 字重 ──
  字重轴收到 300–700（站点最细是 font-light，最粗是 font-bold），一片一个文件，各个字重都在里面：
  切成静态字重的话每个字重一份，界面用字那一层每份 125 kB 左右；可变的一份两百来 kB——
  一个页面通常用到三四个字重，可变的更省，请求数也少得多。

── 其它 ──
  · 只留浏览器默认会开的 OpenType 特性（fontTools 的默认表：ccmp、locl、liga、kern……）；
    竖排特性和竖排度量表去掉，站点没有竖排文字；
  · 地区写法（locl）只留默认：站点没有繁体界面；
  · 授权：名字表留着 SIL OFL 的授权说明与网址，OFL.txt 复制到 public/assets/licenses/，随构建产物分发。

切片带哈希，可以长期缓存。akari.css 由 src/lib/han-font.ts 在应用启动时插入（开发与构建同一份）。

重新运行：
  <装了 fonttools + brotli 的 python> scripts/subset-akari-font.py
改了中文文案、改了 extra-chars.txt、换了新版字体原件，都要重跑。
"""
import hashlib, json, pathlib, shutil, subprocess, tempfile
from concurrent.futures import ProcessPoolExecutor

from fontTools.ttLib import TTFont
from fontTools import subset as ftsubset
from fontTools.varLib import instancer

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / 'fonts-src/akari'
NOTO = ROOT / 'fonts-src/noto/NotoSansSC-VF.woff2'
SLICES = ROOT / 'scripts/cjk-slices/sc.txt'
OUT = ROOT / 'src/assets/fonts'
# 授权全文随产物原样分发（public/ 下的文件不改名）
LICENSE_OUT = ROOT / 'public/assets/licenses/NotoSansSC-OFL.txt'

# 网页字体叫 Noto Sans SC Variable，不和本机装的 Noto Sans SC 重名：@font-face 声明的家族会遮住同名的本机字体，
# 裁掉的生僻字就找不到本机那份了。字体栈里两个都写，见 index.css「字体栈」
FAMILY = 'Noto Sans SC Variable'
AXES = {'wght': (300, 700)}
SCRIPTS = ['DFLT', 'cyrl', 'grek', 'hani', 'kana', 'latn']
VERTICAL = ['vert', 'vrt2', 'valt', 'vkrn', 'vpal', 'vhal']
DROP_TABLES = ['vhea', 'vmtx', 'VORG', 'meta']


def span(a: int, b: int) -> set[int]:
    return set(range(a, b + 1))


# 中文标点：CJK 符号与标点、全角字符、引号破折号省略号、间隔号
HAN_PUNCT = span(0x3000, 0x303f) | span(0xff00, 0xffef) | span(0x2010, 0x2027) | span(0x2030, 0x2033) | {0xb7}
# 拉丁两片。latin 与 Google Fonts 的 latin 分片同一口径，再加上箭头（界面上的 ↑↓ 之类）
LATIN = (span(0x20, 0x7e) | span(0xa0, 0xff) | {0x131, 0x152, 0x153, 0x2bb, 0x2bc, 0x2c6, 0x2da, 0x2dc, 0x304, 0x308, 0x329}
         | span(0x2000, 0x206f) | {0x20ac, 0x2122, 0x2212, 0x2215, 0xfeff, 0xfffd} | span(0x2190, 0x21ff))
EXT = (span(0x100, 0x24f) | span(0x250, 0x2ff) | span(0x300, 0x36f) | span(0x370, 0x3ff) | span(0x400, 0x52f)
       | span(0x1e00, 0x1eff) | span(0x20a0, 0x20cf) | span(0x2100, 0x214f) | span(0x2c60, 0x2c7f) | span(0xa720, 0xa7ff)) - LATIN


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
    """界面会显示的字（非 ASCII），见 scripts/collect-text.mjs"""
    out = subprocess.run(['node', str(ROOT / 'scripts/collect-text.mjs')],
                         check=True, capture_output=True, text=True, cwd=ROOT).stdout
    return {ord(c) for c in json.loads(out)['sc']}


def options() -> ftsubset.Options:
    opts = ftsubset.Options()
    # fontTools 的默认特性表（ccmp、locl、liga 这类浏览器默认会开的），去掉竖排；
    # 另留 pwid：Noto Sans SC 的 ’ ‘ “ ” … 是全角的（占一个汉字宽），英文里 month’s 会被撑开，
    # 英文界面靠它换成比例宽度的那一套（见 index.css「字体栈」的 font-variant-east-asian）
    opts.layout_features = [f for f in opts.layout_features if f not in VERTICAL] + ['pwid']
    # 名字表默认只留 0–6，SIL OFL 要求字体的每一份拷贝都带上授权：13 授权说明、14 授权网址也留下
    opts.name_IDs = [*opts.name_IDs, 13, 14]
    # 地区写法只留默认
    opts.layout_scripts = [f'{s}.dflt' for s in SCRIPTS]
    opts.drop_tables += DROP_TABLES
    return opts


def trim(src: str, dst: str, cps: list[int]) -> str:
    """把原件先裁到本次要收的全部字、字重轴收到 300–700，存成 TTF。
    原件三万多个字形，每切一片都从原件裁要反复解析十几 MB；先裁一遍，后面的切片都从这份小的出。"""
    font = TTFont(src)
    sub = ftsubset.Subsetter(options())
    sub.populate(unicodes=cps)
    sub.subset(font)
    font = instancer.instantiateVariableFont(font, AXES)
    # 可变原件的默认实例是 Thin，名字表里写的就是「Noto Sans SC Thin」；字重轴收窄后默认成了 300，名字跟着改，
    # 免得在开发者工具的「渲染字体」里看到 Thin 以为用错了字重。只是显示名，不影响 CSS 匹配
    names = font['name']
    for rid, value in ((1, 'Noto Sans SC'), (2, 'Regular'), (4, 'Noto Sans SC'), (6, 'NotoSansSC-Regular')):
        names.setName(value, rid, 3, 1, 0x409)
    for rid in (16, 17):
        names.removeNames(nameID=rid)
    font.flavor = None
    font.save(dst)
    return dst


def slice_font(job: tuple[str, str, list[int]]) -> tuple[str, list[int], int]:
    """从裁好的字体里切出一片，返回（文件名, 实际有字形的码位, 字节数）；一个字形都没有就不写文件。"""
    src, dst, cps = job
    font = TTFont(src)
    sub = ftsubset.Subsetter(options())
    sub.populate(unicodes=cps)
    sub.subset(font)
    return save(font, pathlib.Path(dst))


def save(font: TTFont, path: pathlib.Path) -> tuple[str, list[int], int]:
    have = sorted((font.getBestCmap() or {}).keys())
    if not have:
        return str(path), [], 0
    path.parent.mkdir(parents=True, exist_ok=True)
    font.flavor = 'woff2'
    font.save(path)
    # 文件名带内容哈希：字形或裁剪方式一变就是新地址，可以放心长期缓存
    final = path.with_name(f'{path.stem}.{hashlib.sha1(path.read_bytes()).hexdigest()[:8]}.woff2')
    path.rename(final)
    return str(final), have, final.stat().st_size


def face(url: str, cps: list[int]) -> str:
    return (
        f'@font-face {{\n'
        f"  font-family: '{FAMILY}';\n"
        f'  font-style: normal;\n'
        f'  font-display: swap;\n'
        f'  font-weight: {AXES["wght"][0]} {AXES["wght"][1]};\n'
        f"  src: url('{url}') format('woff2');\n"
        f'  unicode-range: {to_ranges(cps)};\n'
        f'}}')


def main() -> int:
    ui = ui_text()
    common = {ord(c) for c in (SRC / 'chars.txt').read_text(encoding='utf-8') if not c.isspace()}
    have = set(TTFont(NOTO).getBestCmap())
    want = have & (common | ui | HAN_PUNCT | LATIN | EXT)
    han = want - LATIN - EXT

    if OUT.exists():
        shutil.rmtree(OUT)

    with tempfile.TemporaryDirectory() as tmp, ProcessPoolExecutor() as pool:
        trimmed = pool.submit(trim, str(NOTO), f'{tmp}/noto.ttf', sorted(want)).result()

        # 拉丁两片在前，CSS 里先声明
        pieces = [('latin', want & LATIN), ('ext', want & EXT)]
        rows = slices()
        sliced = set().union(*(cps for _, cps in rows))
        # 汉字两层各按字频切：界面用字一层（片号照旧），其余常用字一层（片号前加 x）。
        # 混在一起切的话，高频的那几片每片一百八十来个字、界面只用到其中几个，落地页首次访问要多下将近一倍；
        # 分开后界面只碰第一层，第二层只在公告、文档里出现界面没用过的字时才下载。
        for prefix, tier in [('', han & ui), ('x', han - ui)]:
            pieces += [(f'{prefix}{idx}', tier & cps) for idx, cps in [*rows, ('z', han - sliced)]]
        jobs = [(trimmed, str(OUT / 'noto' / f'{name}.woff2'), sorted(cps)) for name, cps in pieces if cps]
        results = list(pool.map(slice_font, jobs))

    # 地址相对 akari.css 所在目录；构建时 Vite 给每个切片加哈希并改写这些地址
    rules = [face(pathlib.Path(dst).relative_to(OUT).as_posix(), got) for dst, got, _ in results if got]
    # SIL OFL：分发字体（含改动后的子集）要附上授权全文
    shutil.copy(NOTO.parent / 'OFL.txt', LICENSE_OUT)
    css = OUT / 'akari.css'
    css.write_text(
        '/*\n'
        ' * 由 scripts/subset-akari-font.py 生成，请勿手改。由 src/lib/han-font.ts 在启动时插入，全平台通用。\n'
        ' * Noto Sans SC（SIL OFL）：英文、数字、常用 3500 字 + 界面用字 + 中文标点，别的字走系统字体。\n'
        ' * 改了中文文案、换了字体原件都要重跑那个脚本。\n'
        ' */\n'
        + '\n'.join(rules) + '\n', encoding='utf-8')

    size = {pathlib.Path(dst).name.split('.')[0]: n / 1024 for dst, got, n in results if got}
    total = sum(size.values())
    n_han = sum(1 for u in han if 0x3400 <= u <= 0x9fff)
    print(f'{FAMILY}（字重 {AXES["wght"][0]}–{AXES["wght"][1]}）：latin {size.get("latin", 0):.0f} kB，ext {size.get("ext", 0):.0f} kB，'
          f'{n_han} 个汉字 + {len(han) - n_han} 个标点符号 {total - size.get("latin", 0) - size.get("ext", 0):.0f} kB')
    print(f'akari.css {css.stat().st_size / 1024:.0f} kB，{len(rules)} 条 @font-face；字体合计 {total / 1024:.2f} MB')

    # 界面上出现、字体里却没有的字：会退回系统字体，一段话里两种字形
    def cjk(u: int) -> bool:
        return 0x3000 <= u <= 0x303f or 0x3400 <= u <= 0x9fff or 0xff00 <= u <= 0xffef
    miss = sorted(u for u in ui - have if cjk(u))
    if miss:
        print(f'  界面用到、字体里没有的字（{len(miss)}）：{"".join(map(chr, miss))}')
    miss = sorted(common - have)
    if miss:
        print(f'  常用字表里、字体里没有的字（{len(miss)}）：{"".join(map(chr, miss))}')

    return 0


if __name__ == '__main__':
    raise SystemExit(main())
