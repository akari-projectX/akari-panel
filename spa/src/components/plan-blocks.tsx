import type { DescriptionBlock } from '@/lib/content-text';
import { cn } from '@/lib/utils';

/**
 * 套餐说明：站长写的纯文本（面板的「Markdown-lite」），按文本节点渲染，绝不当 HTML。
 * 以 - / * / • 开头的行是功能清单（品牌色对勾，见 index.css 的 .plan-rich），其余是段落，空行分块。
 * 解析见 lib/content-text 的 parseDescription。
 *
 * 商店卡片（components/plan-grid）把说明拆成两部分：开头那一段是卡片上的一行简介（lib/content-text 的 `planSummary`），
 * 其余（功能清单等）用 PlanBlocks 照常渲染。
 */
export default function PlanBlocks({ blocks, className }: { blocks: DescriptionBlock[]; className?: string }) {
  if (blocks.length === 0) return null;
  return (
    <div className={cn('plan-rich', className)}>
      {blocks.map((b, i) =>
        b.kind === 'ul' ? (
          <ul key={i}>
            {b.items.map((it, j) => <li key={j}>{it}</li>)}
          </ul>
        ) : (
          <p key={i}>
            {b.lines.map((l, j) => (
              <span key={j}>{j > 0 && <br />}{l}</span>
            ))}
          </p>
        ),
      )}
    </div>
  );
}
