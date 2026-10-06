import { useState } from 'react';
import { Megaphone, Pin } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ReadingDialog } from '@/components/ui/panels';
import type { Announcement } from '@/api';
import { useAnnouncementText } from '@/lib/announcement';
import { formatDateTime } from '@/lib/format';
import { useT } from '@/i18n';
import ServerHtml from '@/components/server-html';

/** 置顶公告的标记，跟在标题前面 */
export function PinBadge({ a }: { a: Announcement }) {
  const tr = useT();
  return a.pinned ? (
    <Badge variant="secondary" className="shrink-0 gap-1 rounded-full bg-brand/10 text-brand-ink">
      <Pin className="size-3" />{tr('置顶')}
    </Badge>
  ) : null;
}

/** 公告详情弹窗，总览页与公告列表页共用。阅读类弹窗，见 components/ui/panels */
export default function AnnouncementDialog({
  item, onClose,
}: { item: Announcement | null; onClose: () => void }) {
  const tr = useT();
  const text = useAnnouncementText();
  /* 关闭时 item 先变成 null、弹窗后退场：退场那几百毫秒里接着显示刚才那一条，不闪成空白 */
  const [shown, setShown] = useState(item);
  if (item && item !== shown) setShown(item);
  const n = item ?? shown;
  const t = n ? text(n) : null;

  return (
    <ReadingDialog
      open={!!item}
      onOpenChange={(o) => !o && onClose()}
      meta={n && (
        <>
          <Megaphone className="size-3.5 text-brand" />
          <PinBadge a={n} />
          <span className="tnum">{formatDateTime(n.created_at)}</span>
        </>
      )}
      title={t?.title ?? ''}
      footer={
        <div className="flex justify-end">
          <Button variant="outline" onClick={onClose}>{tr('我知道了')}</Button>
        </div>
      }
    >
      {/* 正文是面板渲染并清洗好的 HTML，见 components/server-html */}
      {t && <ServerHtml html={t.html} className="text-[14.5px] leading-[1.9]" />}
    </ReadingDialog>
  );
}
