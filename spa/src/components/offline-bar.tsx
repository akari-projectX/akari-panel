import { useEffect, useRef } from 'react';
import { DUR, enterProps, usePresence } from '@/lib/motion';
import { toast } from '@/lib/toast';
import { useOnline } from '@/hooks/use-online';
import { useT } from '@/i18n';

/**
 * 断网时贴在底部的一条。
 * 不做遮罩、不拦操作——页面已经渲染出来的部分照样能看，
 * 只是告诉你接下来点什么可能都没反应。恢复了给一句提示就收走。
 */
export default function OfflineBar() {
  const online = useOnline();
  const tr = useT();
  const wasOffline = useRef(false);

  useEffect(() => {
    if (!online) { wasOffline.current = true; return; }
    if (wasOffline.current) {
      wasOffline.current = false;
      toast.success(tr('网络已恢复'));
    }
  }, [online, tr]);

  const { mounted, leaving } = usePresence(!online, DUR.exit * 1000);

  return mounted && (
    <div
      role="status"
      {...enterProps(true, { duration: DUR.fast })}
      data-leave={leaving}
      className="fixed inset-x-0 bottom-5 z-[60] flex justify-center px-5"
    >
      <div className="flex items-center gap-2.5 rounded-full border border-border bg-popover/95 px-4 py-2 text-[13px] shadow-lg backdrop-blur-sm">
        <span className="size-1.5 shrink-0 rounded-full bg-amber-500" />
        <span className="font-medium">{tr('网络已断开')}</span>
        <span className="text-muted-foreground">{tr('恢复后会自动继续')}</span>
      </div>
    </div>
  );
}
