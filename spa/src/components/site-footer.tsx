import { Link } from 'react-router-dom';
import { useT } from '@/i18n';
import { BRAND, useSite } from '@/lib/site';
import { R } from '@/lib/routes';

/**
 * 全站唯一的页脚：一行版权 + 一组法务/支持链接。
 * 站长在后台配了条款、隐私的外链就用外链，没配用主题自带的页面；后台加的页脚文字和链接接在后面。
 */
export default function SiteFooter() {
  const tr = useT();
  const site = useSite();
  const links: { label: string; to?: string; href?: string }[] = [
    site.tosUrl ? { label: tr('服务条款'), href: site.tosUrl } : { label: tr('服务条款'), to: R.terms },
    site.privacyUrl ? { label: tr('隐私政策'), href: site.privacyUrl } : { label: tr('隐私政策'), to: R.privacy },
    { label: tr('常见问题'), to: R.faq },
    ...site.footerLinks.map((l) => ({ label: l.label, href: l.url })),
  ];
  return (
    <footer className="mt-auto">
      <div className="page-wrap">
        <div aria-hidden className="h-px bg-border" />
      </div>
      <div className="page-wrap flex flex-wrap items-center justify-between gap-x-8 gap-y-4 py-7 text-[12.5px] text-muted-foreground">
        {/* 版权署品牌名 Akari，不取后台站点名称。不显示后端版本号：等于告诉别人后端是什么 */}
        <span className="flex flex-wrap items-center gap-x-2">
          <span>© {new Date().getFullYear()} {BRAND.name}</span>
          {site.footerText && <span className="whitespace-pre-line">{site.footerText}</span>}
        </span>

        <nav className="flex flex-wrap items-center gap-x-1 gap-y-1.5">
          {links.map((l, i) => (
            <span key={`${l.label}-${i}`} className="flex items-center">
              {i > 0 && <span aria-hidden className="mx-0.5 h-3 w-px bg-border" />}
              {l.to ? (
                <Link to={l.to} className="px-1.5 py-0.5 transition-colors hover:text-foreground">{l.label}</Link>
              ) : (
                <a href={l.href} target="_blank" rel="noopener noreferrer" className="px-1.5 py-0.5 transition-colors hover:text-foreground">{l.label}</a>
              )}
            </span>
          ))}
        </nav>
      </div>
    </footer>
  );
}
