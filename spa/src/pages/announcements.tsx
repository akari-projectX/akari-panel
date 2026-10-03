// Ops: the dashboard's announcements (公告). zh/en via the `ann`
// namespace; each announcement shows in the UI language when it has an
// English variant. Opening one marks it read (server-side, per user).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { RichHtml } from "../components/rich-html";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { useLocale, useT } from "../i18n";
import { get, pick, post, type MyAnnouncement, type MyAnnouncements } from "../lib/api";
import { errorText } from "../lib/errors";

export function AnnouncementsCard() {
  const t = useT();
  const list = useQuery({ queryKey: ["my-announcements"], queryFn: () => get<MyAnnouncements>("/me/announcements") });
  const items = list.data?.announcements ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <h2>{t("ann.title")}</h2>
          {list.data && list.data.unread > 0 && (
            <Badge variant="secondary">{t("ann.unreadCount", { count: list.data.unread })}</Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {list.isError && (
          <p role="alert" className="text-sm text-destructive">
            {t("ann.loadFailed", { message: errorText(list.error, t) })}
          </p>
        )}
        {list.isSuccess && items.length === 0 && <p className="text-sm text-muted-foreground">{t("ann.empty")}</p>}
        {items.map((a) => (
          <AnnouncementItem key={a.id} a={a} />
        ))}
      </CardContent>
    </Card>
  );
}

function AnnouncementItem({ a }: { a: MyAnnouncement }) {
  const t = useT();
  const locale = useLocale();
  const qc = useQueryClient();
  // Pinned and unread ones start open.
  const [open, setOpen] = useState(a.pinned || !a.read);
  const read = useMutation({
    mutationFn: () => post<void>(`/me/announcements/${a.id}/read`, {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["my-announcements"] }),
  });
  const title = pick(locale, a.title_zh, a.title_en);
  const html = pick(locale, a.html_zh, a.html_en);
  const date = new Date(a.created_at).toLocaleDateString(locale === "zh" ? "zh-CN" : "en");
  return (
    <article className="rounded-lg border border-border p-4">
      <header className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        {a.pinned && <Badge>{t("ann.pinned")}</Badge>}
        {!a.read && <Badge variant="outline">{t("ann.unread")}</Badge>}
        <span className="ml-auto text-xs text-muted-foreground">{date}</span>
      </header>
      {open && <RichHtml html={html} className="mt-3" />}
      <div className="mt-2 flex gap-2">
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={open}
          onClick={() => {
            const next = !open;
            setOpen(next);
            if (!a.read && !read.isPending) read.mutate();
          }}
        >
          {open ? t("ann.hide") : t("ann.show")}
        </Button>
        {open && !a.read && (
          <Button size="sm" variant="outline" onClick={() => read.mutate()} disabled={read.isPending}>
            {t("ann.markRead")}
          </Button>
        )}
      </div>
    </article>
  );
}
