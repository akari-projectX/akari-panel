import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import { Check, ChevronDown, Copy, Download } from 'lucide-react';
import { useBootOut } from '@/lib/boot';
import { enterProps, stagger, useEnter } from '@/lib/motion';
import { toast } from '@/lib/toast';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useCopy } from '@/hooks/use-copy';
import { useApi } from '@/hooks/use-api';
import { feature, type SubFormat } from '@/api';
import { plannedApi } from '@/api/planned';
import { useAuth } from '@/lib/auth';
import { useSite } from '@/lib/site';
import { R } from '@/lib/routes';
import { PLATFORMS } from '@/data/platforms';
import { SUB_FORMATS, importLinks, mySubUrl, withFormat, type ImportLink } from '@/lib/sub-links';
import { useT, useTp } from '@/i18n';
import { cn } from '@/lib/utils';
/*
 * 二维码中心的品牌标：一张带内容哈希的静态 SVG（assets/），同源加载。
 * 不能写成 data: 地址——面板的 CSP 是 img-src 'self'，data: 图片会被拦。
 */
import QR_MARK from '@/assets/qr-mark.svg';

const PRIMARY_COUNT = 3;

const FORMAT_LABEL: Record<SubFormat, string> = {
  auto: '自动识别',
  clash: 'Clash / mihomo',
  'sing-box': 'sing-box',
  links: '通用链接',
};

/** 复制 / 对勾两个图标叠放交叉过渡；带一点回弹，和其它「操作成功」的弹出同一个手感 */
const ICON_SWAP = 'absolute inset-0 grid place-items-center transition-[opacity,scale] duration-300 ease-[cubic-bezier(.34,1.56,.64,1)]';

/** 取景框四角 */
function Brackets() {
  const ready = useBootOut();
  const corners = [
    'top-0 left-0 border-t-2 border-l-2 rounded-tl-[10px]',
    'top-0 right-0 border-t-2 border-r-2 rounded-tr-[10px]',
    'bottom-0 left-0 border-b-2 border-l-2 rounded-bl-[10px]',
    'bottom-0 right-0 border-b-2 border-r-2 rounded-br-[10px]',
  ];
  return (
    <>
      {corners.map((c, i) => (
        <span
          key={c}
          aria-hidden
          {...enterProps(ready, { delay: stagger(i, 0.2), y: 0, scale: 0.55 })}
          className={`pointer-events-none absolute size-4 border-brand/45 transition-[width,height,border-color] duration-(--dur-base) group-hover:size-5 group-hover:border-brand ${c}`}
        />
      ))}
    </>
  );
}

export default function Subscribe() {
  const enter = useEnter();
  const tr = useT();
  const tp = useTp();
  const nav = useNavigate();
  const { me } = useAuth();
  const site = useSite();
  const [copiedKey, copyText] = useCopy(2200);
  const copied = copiedKey !== null;
  const [sweep, setSweep] = useState(0);
  const [format, setFormat] = useState<SubFormat>('auto');
  const base = mySubUrl(me);
  const url = base ? withFormat(base, format) : '';

  /* 一键导入的客户端：② W30 之后由面板给清单（scheme 以 W30 定稿为准），之前用面板现有的那一份 */
  const server = useApi(() => plannedApi.subClients(), [], { enabled: feature('sub-clients') && !!base });
  const clients: ImportLink[] = useMemo(() => {
    if (!base) return [];
    if (server.data) return server.data.clients.map((c) => ({ id: c.id, name: c.name, platforms: c.platforms.join(' · '), href: c.href }));
    return importLinks(base, site.title);
  }, [base, server.data, site.title]);
  const primary = clients.slice(0, PRIMARY_COUNT);
  const more = clients.slice(PRIMARY_COUNT);

  /* 复制成功与否由返回值决定（失败时 useCopy 已经提示过了），成功才扫一道光 */
  const copy = async () => {
    const ok = await copyText(url);
    if (ok) setSweep((n) => n + 1);
    return ok;
  };

  const copyWithToast = async () => {
    if (await copy()) toast.success(tr('订阅地址已复制'), { description: tr('在客户端中粘贴即可导入') });
  };

  const importTo = (c: ImportLink) => {
    window.location.assign(c.href);
    toast.success(tp('正在唤起 {n}', { n: c.name }), { description: tr('若未自动打开，请确认已安装该客户端') });
  };

  if (!url) return null;
  const downloads = site.downloads;

  return (
    <div className="flex grow flex-wrap items-stretch gap-x-10 gap-y-7">
      {/* ── 左：两个动作，链接本身不呈现 ── */}
      <div className="flex min-w-70 flex-1 flex-col justify-between gap-5">
        <div className="flex flex-wrap items-center gap-2.5">
          <Button
            size="lg"
            onClick={copyWithToast}
            className="relative w-fit shrink-0 overflow-hidden px-4"
          >
            {/* 复制时一道光扫过按钮 */}
            {copied && (
              <span
                key={sweep}
                aria-hidden
                className="pointer-events-none absolute inset-y-0 w-1/2 skew-x-12"
                style={{
                  background: 'linear-gradient(90deg, transparent, rgba(255,255,255,.35), transparent)',
                  animation: 'sweep .7s cubic-bezier(.4, 0, .2, 1) forwards',
                }}
              />
            )}
            <span className="relative grid size-4 place-items-center">
              <span className={cn(ICON_SWAP, copied && 'scale-70 opacity-0')}>
                <Copy className="size-3.5" />
              </span>
              <span className={cn(ICON_SWAP, !copied && 'scale-70 opacity-0')}>
                <Check className="size-4" />
              </span>
            </span>
            <span className="relative">{copied ? tr('已复制订阅链接') : tr('复制订阅链接')}</span>
          </Button>

          {/* 格式：默认按客户端自动识别；认不出的客户端可以手动指定 */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                aria-label={tr('订阅格式')}
                className="inline-flex h-10 items-center gap-1 rounded-lg px-2.5 text-[13px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground data-[state=open]:bg-muted"
              >
                {tr(FORMAT_LABEL[format])}<ChevronDown className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-52">
              {SUB_FORMATS.map((f) => (
                <DropdownMenuItem key={f} onClick={() => setFormat(f)} data-on={f === format} className="justify-between">
                  <span>{tr(FORMAT_LABEL[f])}</span>
                  {f === format && <Check className="size-3.5 text-brand" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div>
          <div className="mb-1.5 text-[12.5px] tracking-[.05em] text-muted-foreground">{tr('导入到客户端')}</div>
          <div className="flex flex-wrap items-center gap-x-1 gap-y-1.5 text-[13.5px] @max-sm:gap-x-2.5">
            {primary.map((c, i) => (
              <span key={c.id} className="flex items-center">
                {i > 0 && <span aria-hidden className="h-3 w-px bg-border @max-sm:hidden" />}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => importTo(c)}
                      className="group/c relative px-1.5 py-1 text-[14px] text-foreground transition-colors hover:text-brand"
                    >
                      {c.name}
                      <span
                        aria-hidden
                        className="absolute inset-x-1.5 -bottom-0.5 h-px origin-left scale-x-0 bg-brand transition-transform duration-(--dur-fast) group-hover/c:scale-x-100"
                      />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>{c.platforms}</TooltipContent>
                </Tooltip>
              </span>
            ))}

            {more.length > 0 && (
              <>
                <span aria-hidden className="h-3 w-px bg-border @max-sm:hidden" />
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button className="flex items-center gap-1 px-1.5 py-1 font-medium text-muted-foreground transition-colors hover:text-brand data-[state=open]:text-brand">
                      {tr('更多')}<ChevronDown className="size-3.5" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-52">
                    {more.map((c) => (
                      <DropdownMenuItem key={c.id} onClick={() => importTo(c)} className="flex-col items-start gap-0.5">
                        <span className="text-[13.5px] font-medium">{c.name}</span>
                        <span className="text-[11.5px] text-muted-foreground">{c.platforms}</span>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            )}
          </div>
        </div>

        {/* 退路：站长在后台配了下载地址的平台直接给下载，没配的去文档页 */}
        <div className="border-t border-border pt-4">
          <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12.5px] text-muted-foreground">
            <Download className="size-3.5" />
            {tr('还没有客户端？')}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="inline-flex items-center gap-1 text-brand underline-offset-4 transition-colors hover:underline data-[state=open]:underline">
                  {tr(downloads.length ? '下载客户端' : '按平台查看教程')}<ChevronDown className="size-3" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-60">
                {downloads.map((d, i) => {
                  const pf = PLATFORMS.find((p) => p.id === d.platform);
                  return (
                    <DropdownMenuItem key={`${d.platform}-${i}`} onClick={() => window.open(d.url, '_blank', 'noopener')} className="items-start gap-3">
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="text-[13.5px] font-medium">{tr(pf?.name ?? d.platform)}</span>
                        <span className="truncate text-[11.5px] text-muted-foreground">{d.label ?? tr(pf?.client ?? '')}</span>
                      </span>
                      <span className="mt-0.5 shrink-0 text-[11.5px] font-medium text-brand">{tr('下载')}</span>
                    </DropdownMenuItem>
                  );
                })}
                {downloads.length === 0 && PLATFORMS.map((pf) => (
                  <DropdownMenuItem
                    key={pf.id}
                    onClick={() => nav(`${R.help}?q=${encodeURIComponent(pf.name)}`)}
                    className="items-start gap-3"
                  >
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="text-[13.5px] font-medium">{tr(pf.name)}</span>
                      <span className="text-[11.5px] text-muted-foreground">{tr(pf.client)}</span>
                    </span>
                    <span className="mt-0.5 shrink-0 text-[11.5px] font-medium text-brand">{tr('看教程')}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </p>
        </div>
      </div>

      {/* ── 右：二维码 ── */}
      <div
        {...enter()}
        className="flex shrink-0 flex-col items-center justify-center gap-2 self-center"
      >
        <div className="group relative p-2.5">
          <Brackets />
          <QRCodeSVG
            value={url}
            size={112}
            level="H"
            fgColor="#0d1526"
            bgColor="#ffffff"
            marginSize={0}
            imageSettings={{ src: QR_MARK, height: 26, width: 26, excavate: true }}
          />
        </div>
        <div className="text-[12px] text-muted-foreground">{tr('扫码导入')}</div>
      </div>
    </div>
  );
}
