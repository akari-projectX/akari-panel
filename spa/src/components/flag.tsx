import {
  AR, AU, BR, CA, CN, DE, FR, GB, HK, ID, IN, JP, KR, MO, MY, NL, PH, RU, SG, TH, TR, TW, US, VN, ZA,
} from 'country-flag-icons/react/3x2';
import { cn } from '@/lib/utils';

/**
 * 国旗图标。用 SVG 而非 emoji —— Windows 系统字体不含 regional indicator 组合字形，
 * emoji 国旗在 Windows Chrome 上会退化成 "HK"、"JP" 这样的字母对。
 *
 * 只按名字逐个引入用得到的那些旗。
 * 原来写的是 `import * as Flags`，这个包的桶文件会把两百多个国家的组件全拉进来，
 * 打包后单独多出 237 kB —— 而节点实际落在这二十几个国家里。
 * 这份名单和 lib/node.ts 的关键词表对应：那边能认出来的国家，这边就得有旗。
 * 查不到的回退成一个占位方块，不猜。
 */
const FLAGS = {
  AR, AU, BR, CA, CN, DE, FR, GB, HK, ID, IN, JP, KR, MO, MY, NL, PH, RU, SG, TH, TR, TW, US, VN, ZA,
} as const;

export default function Flag({ cc, className }: { cc: string; className?: string }) {
  const Svg = FLAGS[cc.toUpperCase() as keyof typeof FLAGS];
  if (!Svg) return <span className={cn('inline-block rounded-[3px] bg-muted', className)} />;
  return (
    <Svg
      title={cc}
      className={cn(
        'inline-block h-[13px] w-5 shrink-0 rounded-[3px] object-cover align-[-1px]',
        'ring-1 ring-black/8',
        className,
      )}
    />
  );
}
