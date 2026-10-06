/*
 * 内容的文本处理。两类内容：
 *
 *   · 公告正文、知识库文章：面板在服务端渲染并清洗好的 HTML（components/server-html 负责显示）。
 *     这里只从中取纯文本（列表摘要、字数）和标题大纲（文章页目录），从不改写它。
 *   · 套餐说明：站长写的纯文本，面板称作「Markdown-lite」——以 - / * / • 开头的行是列表项，
 *     其余是段落，空行分块。按文本节点渲染（components/plan-content），永远不当 HTML。
 *     解析规则与面板自己门户里的 plan-description 一致。
 */

/** HTML → 纯文本（只用于显示摘要、估字数；结果当文本插进页面，React 会转义） */
function plain(html: string | null | undefined, limit = Infinity): string {
  return (html ?? '')
    .slice(0, limit)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 列表里的一句摘要；limit 是先截取的原文长度，摘要只要开头一段，没必要把整篇长文过一遍正则 */
export function summarize(html: string | null | undefined, max = 78): string {
  const text = plain(html, 4000);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 正文大约多少字，用来估阅读时长 */
export function textLength(html: string | null | undefined): number {
  return plain(html).length;
}

export type Heading = { id: string; text: string; level: 2 | 3 };

/** 文章页目录锚点的编号；ServerHtml 按同一顺序给 h3 / h4 加 id */
export const headingId = (index: number) => `sec-${index + 1}`;

/**
 * 文章的标题大纲：面板把内容里的标题渲染成 h3（章节）/ h4（小节），h5、h6 不进目录。
 * 只读不写——DOMParser 解析出的文档不会执行任何脚本，也不进页面。
 */
export function outline(html: string | null | undefined): Heading[] {
  if (!html) return [];
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out: Heading[] = [];
  doc.body.querySelectorAll('h3, h4').forEach((h, i) => {
    const text = h.textContent?.trim();
    if (text) out.push({ id: headingId(i), text, level: h.tagName === 'H3' ? 2 : 3 });
  });
  return out;
}

export type DescriptionBlock = { kind: 'p'; lines: string[] } | { kind: 'ul'; items: string[] };

/* 「- 项目」（单独一个 - 是空项，跳过）；「-5%」是普通文字 */
const BULLET = /^\s*[-*•](?:\s+(.*))?$/;

/** 套餐说明（Markdown-lite 纯文本）→ 段落与列表 */
export function parseDescription(text: string | null | undefined): DescriptionBlock[] {
  const blocks: DescriptionBlock[] = [];
  let cur: DescriptionBlock | null = null;
  for (const raw of (text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    if (line.trim() === '') {
      cur = null;
      continue;
    }
    const m = BULLET.exec(line);
    if (m) {
      const item = (m[1] ?? '').trim();
      if (item === '') continue;
      if (cur?.kind !== 'ul') {
        cur = { kind: 'ul', items: [] };
        blocks.push(cur);
      }
      cur.items.push(item);
    } else {
      if (cur?.kind !== 'p') {
        cur = { kind: 'p', lines: [] };
        blocks.push(cur);
      }
      cur.lines.push(line.trim());
    }
  }
  return blocks;
}

