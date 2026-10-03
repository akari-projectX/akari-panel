// Ops: the portal's help center (帮助 / Help): published knowledge-base
// articles grouped by category, a search over titles and bodies (both
// languages, server-side), and one article at /app/help/<id> (deep link,
// back button). zh/en via the `help` namespace; content shows in the UI
// language when it has an English variant.
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { RichHtml } from "../components/rich-html";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { useLocale, useT } from "../i18n";
import { appBase, get, pick, type HelpArticle, type HelpItem, type HelpList } from "../lib/api";
import { errorText } from "../lib/errors";
import { navigate, usePath } from "../lib/router";

const base = () => `${appBase}/help`;

/** The article id of "/{prefix}/app/help/<id>", if any. */
export function helpArticleOf(path: string): string | null {
  const rest = path.startsWith(`${base()}/`) ? path.slice(base().length + 1) : "";
  const id = rest.split("/")[0];
  return id ? id : null;
}

export function Help() {
  const id = helpArticleOf(usePath());
  return id ? <ArticleView id={id} /> : <HelpIndex />;
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const h = setTimeout(() => setV(value), ms);
    return () => clearTimeout(h);
  }, [value, ms]);
  return v;
}

function HelpIndex() {
  const t = useT();
  const locale = useLocale();
  const [q, setQ] = useState("");
  const query = useDebounced(q.trim(), 300);
  const list = useQuery({
    queryKey: ["my-help", query],
    queryFn: () => get<HelpList>(query ? `/me/help?q=${encodeURIComponent(query)}` : "/me/help"),
  });
  const data = list.data;
  const groups = data
    ? [
        ...data.categories.map((c) => ({ id: c.id, name: pick(locale, c.name_zh, c.name_en), articles: c.articles })),
        ...(data.uncategorized.length
          ? [{ id: "none", name: t("help.uncategorized"), articles: data.uncategorized }]
          : []),
      ]
    : [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t("help.title")}</h2>
        </CardTitle>
        <CardDescription>{t("help.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-1.5">
          <Label htmlFor="help-search">{t("help.search")}</Label>
          <Input
            id="help-search"
            type="search"
            maxLength={64}
            value={q}
            placeholder={t("help.searchPlaceholder")}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        {list.isError && (
          <p role="alert" className="text-sm text-destructive">
            {t("help.loadFailed", { message: errorText(list.error, t) })}
          </p>
        )}
        {data && query && (
          <p role="status" className="text-xs text-muted-foreground">
            {t("help.resultCount", { count: data.total })}
          </p>
        )}
        {data && data.total === 0 && (
          <p className="text-sm text-muted-foreground">{query ? t("help.noResults") : t("help.empty")}</p>
        )}
        {groups.map((g) => (
          <section key={g.id} aria-labelledby={`help-cat-${g.id}`} className="space-y-2">
            <h3 id={`help-cat-${g.id}`} className="text-sm font-semibold">
              {g.name}
            </h3>
            <ul className="divide-y divide-border rounded-lg border border-border">
              {g.articles.map((a) => (
                <li key={a.id}>
                  <ArticleLink a={a} />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </CardContent>
    </Card>
  );
}

function ArticleLink({ a }: { a: HelpItem }) {
  const locale = useLocale();
  const href = `${base()}/${a.id}`;
  return (
    <a
      href={href}
      className="block px-3 py-2.5 text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(href);
      }}
    >
      {pick(locale, a.title_zh, a.title_en)}
    </a>
  );
}

function ArticleView({ id }: { id: string }) {
  const t = useT();
  const locale = useLocale();
  const art = useQuery({ queryKey: ["my-help-article", id], queryFn: () => get<HelpArticle>(`/me/help/${id}`) });
  const a = art.data;
  return (
    <Card>
      <CardHeader>
        <div>
          <Button variant="ghost" size="sm" onClick={() => navigate(base())}>
            ← {t("help.back")}
          </Button>
        </div>
        {a && (
          <>
            <CardTitle>
              <h2>{pick(locale, a.title_zh, a.title_en)}</h2>
            </CardTitle>
            <CardDescription>
              {a.category_zh && `${pick(locale, a.category_zh, a.category_en)} · `}
              {t("help.updated", {
                date: new Date(a.updated_at).toLocaleDateString(locale === "zh" ? "zh-CN" : "en"),
              })}
            </CardDescription>
          </>
        )}
      </CardHeader>
      <CardContent>
        {art.isError && (
          <p role="alert" className="text-sm text-destructive">
            {t("help.loadFailed", { message: errorText(art.error, t) })}
          </p>
        )}
        {a && <RichHtml html={pick(locale, a.html_zh, a.html_en)} />}
      </CardContent>
    </Card>
  );
}
