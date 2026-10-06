import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, Search } from 'lucide-react';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Input } from '@/components/ui/input';
import { FAQS } from '@/data/faqs';
import { useT, useTp } from '@/i18n';
import { R } from '@/lib/routes';

const TOPICS = [
  { k: '开始使用', d: '注册、下单、拿到订阅链接并连上第一个节点。', to: R.help },
  { k: '客户端配置', d: 'Windows / macOS / iOS / Android / Linux / 路由器逐平台步骤。', to: R.help },
  { k: '节点与线路', d: 'CN2 GIA / AS9929 / CMIN2 有什么区别、倍率怎么算、什么时候该换节点。', to: R.nodes },
  { k: '账单与退款', d: '续费、发票、不退款政策与可用性补偿。', to: R.orders },
  { k: '故障排查', d: '连不上、速度慢、频繁断线的自查顺序。', to: R.help },
  { k: '账号安全', d: '重置订阅链接、通行密钥、修改密码与邮箱。', to: R.account },
];

export default function Help() {
  const tr = useT();
  const tp = useTp();
  const [q, setQ] = useState('');
  /* 按当前语言的译文搜（英文界面搜 refund 要能搜到），原文也一并比对，大小写不敏感 */
  const faqs = useMemo(() => FAQS.map((f) => ({ q: tr(f.q), a: tr(f.a), raw: `${f.q}\n${f.a}` })), [tr]);
  const hits = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return faqs;
    return faqs.filter((f) => `${f.q}\n${f.a}\n${f.raw}`.toLowerCase().includes(s));
  }, [q, faqs]);

  return (
    <div className="page-wrap pt-14 pb-24">
      <header className="max-w-[62ch] border-b border-border pb-10">
        <h1 className="page-title">{tr('帮助中心')}</h1>
        <p className="page-sub">{tr('先看下面六个主题；找不到就搜常见问题；还不行就开工单，平均 18 分钟有人回。')}</p>
      </header>

      <section className="grid gap-x-10 gap-y-0 border-b border-border py-4 sm:grid-cols-2 lg:grid-cols-3">
        {TOPICS.map((t) => (
          <Link
            key={t.k} to={t.to}
            className="group flex items-start justify-between gap-4 border-b border-border py-6 last:border-b-0 sm:[&:nth-last-child(-n+2)]:border-b-0 lg:[&:nth-last-child(-n+3)]:border-b-0"
          >
            <div className="min-w-0">
              <div className="text-[15.5px] font-medium transition-colors group-hover:text-brand">{tr(t.k)}</div>
              <p className="mt-2 text-[13.5px] leading-[1.75] text-muted-foreground">{tr(t.d)}</p>
            </div>
            <ArrowUpRight className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-all group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-brand" />
          </Link>
        ))}
      </section>

      <section className="pt-12">
        <div className="flex flex-wrap items-end justify-between gap-5">
          <div>
            <h2 className="text-[21px] font-medium tracking-[-0.024em]">{tr('常见问题')}</h2>
            <p className="mt-2 text-[13.5px] text-muted-foreground">
              {tp('共 {n} 条', { n: hits.length })}{q && ` · ${tr('已按关键词过滤')}`}
            </p>
          </div>
          <div className="relative w-full max-w-[320px]">
            <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label={tr('搜索问题关键词')}
              value={q} onChange={(e) => setQ(e.target.value)}
              placeholder={tr('搜索问题关键词')} className="h-10 pl-9"
            />
          </div>
        </div>

        {hits.length === 0 ? (
          <p className="border-t border-border py-14 text-center text-[14px] text-muted-foreground">
            {tr('没有匹配的条目。换个词，或者直接')}
            <Link to={R.tickets} className="mx-1 font-medium text-brand hover:underline">{tr('开一张工单')}</Link>
            {tr('。')}
          </p>
        ) : (
          <Accordion type="single" collapsible className="mt-7">
            {hits.map((f, i) => (
              <AccordionItem key={i} value={`q${i}`}>
                <AccordionTrigger className="text-left text-[15.5px] font-medium">{f.q}</AccordionTrigger>
                <AccordionContent className="text-[14.5px] leading-[1.9] text-muted-foreground">{f.a}</AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        )}
      </section>
    </div>
  );
}
