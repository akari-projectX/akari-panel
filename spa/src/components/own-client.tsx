import { Download, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useSite } from '@/lib/site';
import { PLATFORMS } from '@/data/platforms';
import { useT } from '@/i18n';

/**
 * 仅自研客户端模式（后台 系统设置 → 订阅 → 仅自研客户端；`me.sub_own_client`）的接入区：
 * 不显示订阅链接、复制、二维码与一键导入，只给 Akari 客户端的下载（后台「外观与品牌」里的客户端下载链接）；
 * 站长没配下载地址时只留一句中性的说明。客户端里登录账户即可自动获取节点。
 */
export default function OwnClient() {
  const tr = useT();
  const site = useSite();
  const downloads = site.downloads;
  return (
    <div data-testid="own-client" className="flex grow flex-col gap-4">
      <p className="text-[14px] text-foreground">{tr('在客户端里登录账户即可自动获取节点')}</p>
      {downloads.length > 0 ? (
        <div className="flex flex-wrap gap-2.5">
          {downloads.map((d, i) => {
            const pf = PLATFORMS.find((p) => p.id === d.platform);
            return (
              <Button key={`${d.platform}-${i}`} variant={i === 0 ? 'default' : 'outline'} className="h-9" asChild>
                <a href={d.url} target="_blank" rel="noopener noreferrer">
                  <Download className="size-3.5" />
                  {d.label ?? tr(pf?.name ?? d.platform)}
                </a>
              </Button>
            );
          })}
        </div>
      ) : (
        <p className="flex items-start gap-1.5 text-[13px] text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" />
          {tr('客户端下载地址还没有公布，请留意公告或联系客服。')}
        </p>
      )}
    </div>
  );
}
