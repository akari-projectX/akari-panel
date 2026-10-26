<script lang="ts">
  import { ApiError, pageApi, type LegalPage } from '@/api';
  import Loading from '../components/Loading.svelte';
  import LoadError from '../components/LoadError.svelte';
  import RichHtml from '../components/RichHtml.svelte';
  import { siteName } from '$lib/auth.svelte';
  import { formatDate } from '@/lib/format';
  import { i18n, t, tp } from '$lib/i18n.svelte';
  import { loc } from '$lib/router.svelte';
  import { R } from '$lib/routes';
  import { pick } from '$lib/site';

  /*
   * 服务条款 / 隐私政策（公开页；与 React 门户 pages/legal.tsx 相同）。
   *
   * 内容由站长在后台知识库里写：固定 slug 为 terms、privacy 的已发布文章（GET /api/v1/pages/{slug}，面板服务端渲染并清洗过的 HTML）。
   * 门户不内置任何法律文本：每个站点的缔约方、适用法律、退款规则都不同。没写时（面板答统一的 404）显示一段中性的缺省说明，不做任何承诺。
   * 站长在品牌设置里配了条款 / 隐私的外链时，页脚、注册页直接指向外链，不会进到这一页。
   * 版式（v1.4.0）：居中的阅读栏（最宽 760px，与设置页同宽）、标题 + 「最后更新」、1px 细线、正文。
   */
  let { title }: { title: string; params?: Record<string, string> } = $props();

  const slug: 'terms' | 'privacy' = loc.path === R.privacy ? 'privacy' : 'terms';
  let doc = $state<LegalPage>();
  let error = $state<unknown>();
  let loading = $state(true);

  function load() {
    loading = true;
    error = undefined;
    pageApi.get(slug).then(
      (d) => { doc = d; },
      (e: unknown) => { error = e; },
    ).finally(() => { loading = false; });
  }
  load();

  const missing = $derived(error instanceof ApiError && error.status === 404);
</script>

<div class="lg-page"><article class="legal">
  <header>
    <h1>{doc ? pick(i18n.locale, doc.title_zh, doc.title_en) : t(title)}</h1>
    {#if doc}<p class="lg-date">{t('最后更新')} <span class="num">{formatDate(doc.updated_at)}</span></p>{/if}
  </header>
  {#if loading && !doc}
    <Loading rows={6} />
  {:else if doc}
    <RichHtml html={pick(i18n.locale, doc.html_zh, doc.html_en)} />
  {:else if missing}
    <p class="legal-missing">{tp('{site} 尚未发布这份文件。如有疑问，请登录后提交工单联系我们。', { site: siteName() })}</p>
  {:else}
    <LoadError {error} onretry={load} />
  {/if}
</article></div>
