import { useState } from 'react';
import { cn } from '@/lib/utils';
import { useSite } from '@/lib/site';
import SEAL_LIGHT from '@/assets/brand/logo.png';
import SEAL_DARK from '@/assets/brand/logo-dark.png';

/**
 * 品牌印章（AKARI 灯塔）—— 实现设计规范《印章系统》。
 *
 * 整套只有两个动作：切一个方块、把字填满它。规范明令禁止：缝、圆角、渐变、投影、外发光、描边、换字体。
 *
 * 印章是两张现成的 PNG（src/assets/brand/），不是网页字体、也不再是运行时拼的字形轮廓：
 *   logo.png       浅色底用：夜色拉丁块 + 金色中文块
 *   logo-dark.png  深色底用：雾白拉丁块 + 金色中文块（主锁定）
 * 字面是 Michroma 400 与 Noto Serif SC 900，由这两款字体按规范比例排好后栅格化，
 * 与 public/brand/ 下的两张矢量标志逐像素对齐（584×124，纯色三种、只有抗锯齿边缘是过渡色）。
 * 每张约 3 kB，打包时直接内联进脚本：零请求、零字体，首帧就是最终形态。
 * 页头显示 31px 高，图是它的 4 倍，1x、2x 屏正好整数倍缩小，3x 屏也够清楚。
 * 改字标要找设计重出这两张图（或用 public/brand/ 下的矢量标志导出），替换同名文件即可。
 */

/** 透镜 O：一个圆被一道横向光带切开。规范给定路径，按原样使用。 */
export const LENS_PATH = 'M50 2A48 48 0 1 0 50 98A48 48 0 1 0 50 2Z M2 42H98V58H2Z';

/**
 * 底色适配（规范 06）：浅色底用夜色拉丁块那张，深色底用雾白拉丁块那张。
 * 规范里的金色底版、单色版站内用不到，不出图。
 */
const SEAL = { onLight: SEAL_LIGHT, onDark: SEAL_DARK } as const;
export type SealTone = keyof typeof SEAL;

/** 图片原尺寸 584×124 */
const SEAL_RATIO = 584 / 124;

/**
 * 尺寸只有一个驱动量：拉丁字号 en，方块高度 H = en × 1.64（规范 04）。
 * sm / md / lg 对应 17 / 19 / 28，即高 28 / 31 / 46 px。
 */
const SIZE = { sm: 17, md: 19, lg: 28 } as const;

function Seal({ tone, size, className }: { tone: SealTone; size: keyof typeof SIZE; className?: string }) {
  const site = useSite();
  const h = Math.round(SIZE[size] * 1.64);
  return (
    <img
      src={SEAL[tone]} alt={site.title} width={Math.round(h * SEAL_RATIO)} height={h} draggable={false}
      className={cn('inline-block select-none align-middle', className)}
    />
  );
}

/** 站点自定义标识的显示高度，按主锁定那三档字号折算，换标不会把导航撑变形 */
const IMG_HEIGHT = { sm: 24, md: 28, lg: 40 } as const;

/**
 * 主锁定。
 *
 * tone="auto"（默认）随明暗模式切换：两份都画出来，用 CSS 显隐，
 * 而不是读 useTheme() 再条件渲染——后者在水合前拿不到值，会先画错一版再跳。
 *
 * 前置规则：站长在后台配了 LOGO（面板 branding.logo_url）就用它，没配时才回落到印章。
 *
 * 配了但图片加载失败（地址填错、图床失效、被墙）时同样回落到印章：
 * 以前这种情况导航栏左上角直接空掉，看起来像是「默认标识不见了」。
 */
export function Logo({
  tone = 'auto', size = 'md', className,
}: {
  tone?: SealTone | 'auto';
  size?: keyof typeof SIZE;
  className?: string;
}) {
  /* 站长配的图有一张加载失败就整体退回印章，不留半边空白 */
  const [broken, setBroken] = useState(false);
  const site = useSite();
  if (site.logo && !broken) {
    /* 面板只有一张 LOGO：明暗两种底色都用它 */
    return (
      <img
        src={site.logo} alt={site.title}
        onError={() => setBroken(true)}
        style={{ height: IMG_HEIGHT[size] }}
        className={cn('w-auto max-w-[200px] object-contain select-none', className)}
      />
    );
  }
  if (tone !== 'auto') return <Seal tone={tone} size={size} className={className} />;
  return (
    <>
      <Seal tone="onLight" size={size} className={cn('dark:hidden', className)} />
      <Seal tone="onDark" size={size} className={cn('hidden dark:inline-block', className)} />
    </>
  );
}
