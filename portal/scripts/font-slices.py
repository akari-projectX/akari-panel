#!/usr/bin/env python3
"""
HarmonyOS Sans SC 的网页切片（用户 2026-10-31 选定，见 portal/CLAUDE.md「字体」）。切片只按 unicode-range 把字形分到若干文件里，字形与字体信息原样保留，不改动字体本身。

用法（需要 fonttools 与 brotli：python3 -m pip install fonttools brotli）：
    python3 portal/scripts/font-slices.py <HarmonyOS_Sans_SC 目录>

读 HarmonyOS_Sans_SC_Regular.ttf（400）、HarmonyOS_Sans_SC_Medium.ttf（500，只用于顶栏导航）与 HarmonyOS_Sans_SC_Bold.ttf（600 用它），字符集 = ASCII 与常用标点符号 + GB2312 全部汉字
+ 门户源码里出现的全部字符；按「门户界面先用到的字在前、其余 GB2312 按编码」切成每片约 200 字，输出 WOFF2 到 src/assets/fonts/hos/，
并生成 src/styles/fonts.css（@font-face + unicode-range：浏览器只下载页面上真正用到的片）。产物进仓库，CI 不跑本脚本。
"""
import pathlib
import re
import subprocess
import sys

PORTAL = pathlib.Path(__file__).resolve().parent.parent
OUT = PORTAL / 'src/assets/fonts/hos'
CSS = PORTAL / 'src/styles/fonts.css'
SLICE = 200
WEIGHTS = {400: 'HarmonyOS_Sans_SC_Regular.ttf', 500: 'HarmonyOS_Sans_SC_Medium.ttf', 600: 'HarmonyOS_Sans_SC_Bold.ttf'}


def gb2312():
    out = []
    for hi in range(0xB0, 0xF8):
        for lo in range(0xA1, 0xFF):
            try:
                out.append(bytes([hi, lo]).decode('gb2312'))
            except UnicodeDecodeError:
                pass
    return out


def portal_chars():
    seen = {}
    for f in (PORTAL / 'src').rglob('*'):
        if f.suffix in {'.svelte', '.ts', '.css', '.html'} and 'assets' not in f.parts:
            for ch in f.read_text(encoding='utf-8', errors='ignore'):
                if ord(ch) > 0x2E7F:
                    seen[ch] = seen.get(ch, 0) + 1
    return [c for c, _ in sorted(seen.items(), key=lambda kv: -kv[1])]


def ranges(cps):
    cps = sorted(set(cps))
    out, start, prev = [], cps[0], cps[0]
    for c in cps[1:]:
        if c == prev + 1:
            prev = c
            continue
        out.append((start, prev))
        start = prev = c
    out.append((start, prev))
    return ', '.join(f'U+{a:X}' if a == b else f'U+{a:X}-{b:X}' for a, b in out)


def main():
    src = pathlib.Path(sys.argv[1])
    latin = list(range(0x20, 0x7F)) + list(range(0xA0, 0x180)) + list(range(0x2000, 0x2070)) + [0x20AC, 0x2116, 0x2122] \
        + list(range(0x2190, 0x21A0)) + list(range(0x2460, 0x2474)) + list(range(0x25A0, 0x2600)) + list(range(0x2713, 0x2717))
    cjk_punct = list(range(0x3000, 0x3040)) + list(range(0xFF00, 0xFFF0))
    order = []
    for ch in portal_chars() + gb2312():
        if ch not in order:
            order.append(ch)
    order = [ord(c) for c in order if ord(c) not in cjk_punct]
    slices = [latin + cjk_punct] + [order[i:i + SLICE] for i in range(0, len(order), SLICE)]
    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob('*.woff2'):
        old.unlink()
    css = ['/* 生成文件：portal/scripts/font-slices.py。HarmonyOS Sans SC（© 2021 Huawei Device Co., Ltd.，HarmonyOS Sans Fonts License Agreement，'
           '协议原文 src/assets/fonts/hos/LICENSE.txt）。 */']
    for weight, name in WEIGHTS.items():
        for i, cps in enumerate(slices):
            out = OUT / f'hos-{weight}-{i:02d}.woff2'
            subprocess.run([sys.executable, '-m', 'fontTools.subset', str(src / name), f'--output-file={out}', '--flavor=woff2',
                            '--unicodes=' + ','.join(f'{c:X}' for c in cps), '--layout-features=*', '--no-hinting', '--desubroutinize'],
                           check=True)
            css.append(f"@font-face {{ font-family: 'HarmonyOS Sans SC'; font-style: normal; font-weight: {weight}; font-display: swap; "
                       f"src: url('../assets/fonts/hos/{out.name}') format('woff2'); unicode-range: {ranges(cps)}; }}")
    lic = src / 'LICENSE.txt'
    (OUT / 'LICENSE.txt').write_text(lic.read_bytes().rstrip(b'\0').decode('utf-8', errors='replace'), encoding='utf-8')
    CSS.write_text('\n'.join(css) + '\n', encoding='utf-8')
    total = sum(p.stat().st_size for p in OUT.glob('*.woff2'))
    print(f'{len(slices)} slices x {len(WEIGHTS)} weights, {total / 1024 / 1024:.1f} MiB')


if __name__ == '__main__':
    main()
