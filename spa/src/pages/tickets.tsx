// W17 user portal: support tickets (工单). zh/en via the `tickets`
// namespace. Customers see their own tickets only; staff replies show as
// "Support" (the server never sends admin logins to customers). Available
// to expired / quota-exhausted accounts too (R21 renewal scope).
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";

import { useLocale, useT, type MessageKey } from "../i18n";
import {
  get,
  post,
  TICKET_CATEGORIES,
  TICKET_MAX_BODY,
  TICKET_MAX_SUBJECT,
  TICKET_PRIORITIES,
  type MyTicketRow,
  type MyTicketView,
  type TicketCategory,
  type TicketPriority,
  type TicketStatus,
} from "../lib/api";
import type { MyOrder } from "../lib/billing";
import { errorText } from "../lib/errors";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { Textarea } from "../components/ui/textarea";

export const STATUS_KEY = {
  open: "tickets.statusOpen",
  answered: "tickets.statusAnswered",
  closed: "tickets.statusClosed",
} as const satisfies Record<TicketStatus, MessageKey>;

export const CATEGORY_KEY = {
  general: "tickets.catGeneral",
  billing: "tickets.catBilling",
  technical: "tickets.catTechnical",
  account: "tickets.catAccount",
  other: "tickets.catOther",
} as const satisfies Record<TicketCategory, MessageKey>;

export const PRIORITY_KEY = {
  low: "tickets.priLow",
  normal: "tickets.priNormal",
  high: "tickets.priHigh",
  urgent: "tickets.priUrgent",
} as const satisfies Record<TicketPriority, MessageKey>;

const SELECT = "h-9 w-full rounded-lg border border-border bg-background px-2 text-sm";

function useFmt() {
  const locale = useLocale();
  return (s: string) => new Date(s).toLocaleString(locale === "zh" ? "zh-CN" : "en");
}

function StatusBadge({ status }: { status: TicketStatus }) {
  const t = useT();
  const variant = status === "answered" ? "success" : status === "closed" ? "secondary" : "outline";
  return <Badge variant={variant}>{t(STATUS_KEY[status])}</Badge>;
}

export function Tickets() {
  const t = useT();
  const fmt = useFmt();
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const list = useQuery({
    queryKey: ["my-tickets"],
    queryFn: () => get<MyTicketRow[]>("/me/tickets"),
    refetchInterval: 30_000,
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle>
            <h2>{t("tickets.title")}</h2>
          </CardTitle>
          <CardDescription>{t("tickets.subtitle")}</CardDescription>
        </div>
        {!creating && !open && (
          <Button
            size="sm"
            onClick={() => {
              setCreating(true);
              setNotice(null);
            }}
          >
            {t("tickets.newTicket")}
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {notice && (
          <p role="status" className="text-sm text-emerald-700">
            {notice}
          </p>
        )}
        {creating ? (
          <NewTicket
            onCancel={() => setCreating(false)}
            onCreated={(id) => {
              setCreating(false);
              setNotice(t("tickets.created"));
              setOpen(id);
            }}
          />
        ) : open ? (
          <Thread id={open} onBack={() => setOpen(null)} />
        ) : list.isPending ? (
          <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
        ) : list.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {errorText(list.error, t)}
          </p>
        ) : list.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("tickets.empty")}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("tickets.colSubject")}</TableHead>
                <TableHead>{t("tickets.colStatus")}</TableHead>
                <TableHead>{t("tickets.colUpdated")}</TableHead>
                <TableHead className="text-right" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-medium">
                    {r.subject}
                    <span className="block text-xs text-muted-foreground">{t(CATEGORY_KEY[r.category])}</span>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={r.status} />
                    {r.unread && (
                      <Badge variant="destructive" className="ml-2">
                        {t("tickets.unread")}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{fmt(r.updated_at)}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setOpen(r.id);
                        setNotice(null);
                      }}
                    >
                      {t("tickets.view")}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function NewTicket({ onCancel, onCreated }: { onCancel: () => void; onCreated: (id: string) => void }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [subject, setSubject] = useState("");
  const [category, setCategory] = useState<TicketCategory>("technical");
  const [priority, setPriority] = useState<TicketPriority>("normal");
  const [message, setMessage] = useState("");
  const [orderId, setOrderId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const orders = useQuery({ queryKey: ["my-orders"], queryFn: () => get<MyOrder[]>("/me/orders") });

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!subject.trim() || !message.trim()) {
      setError(t("tickets.required"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { subject: subject.trim(), category, priority, message };
      if (orderId) body.order_id = orderId;
      const res = await post<{ id: string }>("/me/tickets", body);
      await queryClient.invalidateQueries({ queryKey: ["my-tickets"] });
      onCreated(res.id);
    } catch (err) {
      setError(errorText(err, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="space-y-3" onSubmit={submit} aria-label={t("tickets.newTicket")}>
      <div className="space-y-1">
        <Label htmlFor="tk-subject">{t("tickets.subject")}</Label>
        <Input
          id="tk-subject"
          value={subject}
          maxLength={TICKET_MAX_SUBJECT}
          onChange={(e) => setSubject(e.target.value)}
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor="tk-category">{t("tickets.category")}</Label>
          <select
            id="tk-category"
            className={SELECT}
            value={category}
            onChange={(e) => setCategory(e.target.value as TicketCategory)}
          >
            {TICKET_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {t(CATEGORY_KEY[c])}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="tk-priority">{t("tickets.priority")}</Label>
          <select
            id="tk-priority"
            className={SELECT}
            value={priority}
            onChange={(e) => setPriority(e.target.value as TicketPriority)}
          >
            {TICKET_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {t(PRIORITY_KEY[p])}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="tk-order">{t("tickets.linkOrder")}</Label>
          <select id="tk-order" className={SELECT} value={orderId} onChange={(e) => setOrderId(e.target.value)}>
            <option value="">{t("tickets.none")}</option>
            {(orders.data ?? []).map((o) => (
              <option key={o.id} value={o.id}>
                {o.out_trade_no} · {o.plan_name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor="tk-message">{t("tickets.message")}</Label>
        <Textarea
          id="tk-message"
          rows={6}
          value={message}
          maxLength={TICKET_MAX_BODY}
          placeholder={t("tickets.messagePlaceholder")}
          onChange={(e) => setMessage(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          {t("tickets.charsLeft", { count: TICKET_MAX_BODY - message.length })}
        </p>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>
          {busy ? t("tickets.submitting") : t("tickets.submit")}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          {t("tickets.cancel")}
        </Button>
      </div>
    </form>
  );
}

function Thread({ id, onBack }: { id: string; onBack: () => void }) {
  const t = useT();
  const fmt = useFmt();
  const queryClient = useQueryClient();
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ticket = useQuery({
    queryKey: ["my-ticket", id],
    queryFn: () => get<MyTicketView>(`/me/tickets/${id}`),
    refetchInterval: 30_000,
  });

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["my-ticket", id] }),
      queryClient.invalidateQueries({ queryKey: ["my-tickets"] }),
    ]);
  }

  async function send(e: FormEvent) {
    e.preventDefault();
    if (!reply.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await post(`/me/tickets/${id}/replies`, { message: reply });
      setReply("");
      await refresh();
    } catch (err) {
      setError(errorText(err, t));
    } finally {
      setBusy(false);
    }
  }

  async function close() {
    if (!window.confirm(t("tickets.closeConfirm"))) return;
    setError(null);
    try {
      await post(`/me/tickets/${id}/close`, {});
      await refresh();
    } catch (err) {
      setError(errorText(err, t));
    }
  }

  // Leaving the thread refreshes the list's unread markers.
  function back() {
    void queryClient.invalidateQueries({ queryKey: ["my-tickets"] });
    onBack();
  }

  if (ticket.isPending) return <p className="text-sm text-muted-foreground">{t("common.loading")}</p>;
  if (ticket.isError)
    return (
      <div className="space-y-2">
        <p role="alert" className="text-sm text-destructive">
          {errorText(ticket.error, t)}
        </p>
        <Button variant="outline" size="sm" onClick={back}>
          {t("tickets.back")}
        </Button>
      </div>
    );
  const v = ticket.data;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-medium">{v.subject}</h3>
          <p className="text-xs text-muted-foreground">
            {t(CATEGORY_KEY[v.category])} · {t(PRIORITY_KEY[v.priority])} · {fmt(v.created_at)}
            {v.order_no && <> · {t("tickets.linkedOrder", { order: v.order_no })}</>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={v.status} />
          <Button variant="outline" size="sm" onClick={back}>
            {t("tickets.back")}
          </Button>
        </div>
      </div>
      <ol className="space-y-3" aria-label={v.subject}>
        {v.messages.map((m) => (
          <li
            key={m.id}
            className={`rounded-lg border p-3 text-sm ${m.staff ? "border-primary/30 bg-primary/5" : "border-border"}`}
          >
            <p className="mb-1 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{m.staff ? t("tickets.staff") : t("tickets.you")}</span>
              {" · "}
              {fmt(m.created_at)}
            </p>
            <p className="whitespace-pre-wrap break-words">{m.body}</p>
          </li>
        ))}
      </ol>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {v.status === "closed" ? (
        <p className="text-sm text-muted-foreground">{t("tickets.closedNote")}</p>
      ) : (
        <form className="space-y-2" onSubmit={send}>
          <Label htmlFor="tk-reply">{t("tickets.reply")}</Label>
          <Textarea
            id="tk-reply"
            rows={4}
            value={reply}
            maxLength={TICKET_MAX_BODY}
            placeholder={t("tickets.replyPlaceholder")}
            onChange={(e) => setReply(e.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy || !reply.trim()}>
              {busy ? t("tickets.sending") : t("tickets.send")}
            </Button>
            <Button type="button" variant="outline" onClick={close}>
              {t("tickets.close")}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
