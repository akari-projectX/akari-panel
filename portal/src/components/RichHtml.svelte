<script lang="ts">
  /*
   * 显示面板下发的 HTML：公告正文、知识库文章、条款与隐私。**全站唯一一处 {@html} 的地方**。
   *
   * 为什么可以直接插：这些 HTML 由面板在服务端从一个安全的 Markdown 子集渲染出来，渲染器本身就是清洗器
   * （akari-panel src/markdown.rs）——输入里的任何 HTML 都被转义成文字；输出只有固定的标签
   * p br h3–h6 strong em code pre ul ol li blockquote hr a img，没有 style、class、id、on* 属性；
   * 链接只能是 http(s)、mailto 或站内地址，外链带 rel="noopener noreferrer"；图片只能是 https 或站内。
   * 再加上面板的 CSP（default-src 'self'，不允许内联脚本），前端不再解析 Markdown，也不做第二遍清洗。
   * 只能把面板接口返回的 HTML 传进来——用户输入、地址栏参数、任何别的来源都不行。
   */
  import { headingId } from '@/lib/content-text';

  /* headings：给 h3 / h4 按顺序补上目录锚点 id（编号与 @/lib/content-text 的 outline 一致；只加属性，不改内容） */
  let { html, headings = false, article = false }: { html?: string | null; headings?: boolean; article?: boolean } = $props();
  let el = $state<HTMLDivElement>();

  $effect(() => {
    void html;
    if (headings && el) el.querySelectorAll('h3, h4').forEach((h, i) => { h.id = headingId(i); });
  });
</script>

{#if html}
  <div class="rich" class:rich-article={article} bind:this={el}>{@html html}</div>
{/if}
