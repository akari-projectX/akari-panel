import { ApiError, pageApi } from '@/api';
import ServerHtml from '@/components/server-html';
import { LoadError, Loading } from '@/components/data-state';
import { useApi } from '@/hooks/use-api';
import { pick } from '@/lib/doc-categories';
import { formatDate } from '@/lib/format';
import { useSite } from '@/lib/site';
import { useEnter } from '@/lib/motion';
import { useLocale, useT, useTp } from '@/i18n';

/**
 * 服务条款 / 隐私政策（公开页）。
 *
 * 内容由站长在后台知识库里写：固定 slug 为 `terms`、`privacy` 的已发布文章（GET /api/v1/pages/{slug}，
 * 面板服务端渲染并清洗过的 HTML）。门户不内置任何法律文本：每个站点的缔约方、适用法律、退款规则都不同，
 * 写死一份只会和站点的真实规则冲突。没写时（面板答统一的 404）显示一段中性的缺省说明，不做任何承诺。
 *
 * 站长在品牌设置里配了条款 / 隐私的外链时，页脚直接指向外链，不会进到这一页。
 */
function LegalPage({ slug, title }: { slug: 'terms' | 'privacy'; title: string }) {
  const tr = useT();
  const tp = useTp();
  const { locale } = useLocale();
  const site = useSite();
  const enter = useEnter();
  const page = useApi(() => pageApi.get(slug), [slug]);
  const missing = page.error instanceof ApiError && page.error.status === 404;

  return (
    <div className="page-wrap pt-14 pb-24">
      <header {...enter()} className="max-w-[68ch] border-b border-border pb-8">
        <h1 className="page-title">{page.data ? pick(locale, page.data.title_zh, page.data.title_en) : tr(title)}</h1>
        {page.data && (
          <div className="mt-3 text-[12.5px] text-muted-foreground">
            {tr('最后更新')} {formatDate(page.data.updated_at)}
          </div>
        )}
      </header>
      <div className="max-w-[68ch] pt-8">
        {page.loading && !page.data ? (
          <Loading rows={6} />
        ) : page.data ? (
          <ServerHtml html={pick(locale, page.data.html_zh, page.data.html_en)} />
        ) : missing ? (
          <p className="text-[14.5px] leading-[1.9] text-muted-foreground">
            {tp('{site} 尚未发布这份文件。如有疑问，请登录后提交工单联系我们。', { site: site.title })}
          </p>
        ) : (
          <LoadError error={page.error} onRetry={page.reload} />
        )}
      </div>
    </div>
  );
}

export function Terms() {
  return <LegalPage slug="terms" title="服务条款" />;
}

export function Privacy() {
  return <LegalPage slug="privacy" title="隐私政策" />;
}
