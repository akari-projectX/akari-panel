// W16 user portal: balance (余额) with its ledger and withdrawals, and the
// invite programme (我的邀请). zh/en via the `wallet` / `invite` namespaces.
// Amounts are integer fen from the server; the only amount a user types is
// a withdrawal, parsed as text (parseYuan) and checked again by the server.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { useLocale, useT, type MessageKey } from "../i18n";
import { get, post, type Me } from "../lib/api";
import {
  parseYuan,
  signedYuan,
  yuan,
  type CommissionStatus,
  type LedgerKind,
  type MyBalance,
  type MyInvite,
  type Withdrawal,
  type WithdrawalStatus,
  type WithdrawMethod,
} from "../lib/billing";
import { errorText } from "../lib/errors";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { InviteCodes } from "./portal-account";

export const KIND_KEY = {
  commission: "wallet.kindCommission",
  admin_adjust: "wallet.kindAdminAdjust",
  order_payment: "wallet.kindOrderPayment",
  refund_to_balance: "wallet.kindRefundToBalance",
  withdrawal: "wallet.kindWithdrawal",
  withdrawal_reversal: "wallet.kindWithdrawalReversal",
} as const satisfies Record<LedgerKind, MessageKey>;

const W_STATUS_KEY = {
  pending: "wallet.statusPending",
  approved: "wallet.statusApproved",
  rejected: "wallet.statusRejected",
  cancelled: "wallet.statusCancelled",
} as const satisfies Record<WithdrawalStatus, MessageKey>;

const METHOD_KEY = {
  alipay: "wallet.methodAlipay",
  wechat: "wallet.methodWechat",
  bank: "wallet.methodBank",
  other: "wallet.methodOther",
} as const satisfies Record<WithdrawMethod, MessageKey>;

const C_STATUS_KEY = {
  pending: "invite.statusPending",
  credited: "invite.statusCredited",
  reversed: "invite.statusReversed",
} as const satisfies Record<CommissionStatus, MessageKey>;

function useFmt() {
  const locale = useLocale();
  return (s: string | null) => (s ? new Date(s).toLocaleString(locale === "zh" ? "zh-CN" : "en") : "—");
}

/** Balance + (for accounts in good standing) invitations and withdrawals. */
export function Wallet({ me }: { me: Me }) {
  // Expired / quota-exhausted accounts (R21 renewal scope) may see and
  // spend their balance; invitations and withdrawals need a full session.
  const restricted = me.expired || me.quota_exhausted;
  return (
    <div className="space-y-6">
      <BalanceCard canWithdraw={!restricted} />
      {!restricted && <InviteCard />}
    </div>
  );
}

function BalanceCard({ canWithdraw }: { canWithdraw: boolean }) {
  const t = useT();
  const fmt = useFmt();
  const balance = useQuery({ queryKey: ["my-balance"], queryFn: () => get<MyBalance>("/me/balance") });
  const b = balance.data;
  if (!b) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t("wallet.title")}</h2>
        </CardTitle>
        <CardDescription>{t("wallet.subtitle")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-4 text-sm">
          <span className="text-base font-semibold">{t("wallet.balance", { amount: yuan(b.balance_cents) })}</span>
          <span className="text-muted-foreground">
            {t("wallet.withdrawable", { amount: yuan(b.withdrawable_cents) })}
          </span>
        </div>
        <h3 className="text-sm font-medium">{t("wallet.ledgerTitle")}</h3>
        {b.entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("wallet.ledgerEmpty")}</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("wallet.colTime")}</TableHead>
                  <TableHead>{t("wallet.colKind")}</TableHead>
                  <TableHead>{t("wallet.colAmount")}</TableHead>
                  <TableHead>{t("wallet.colAfter")}</TableHead>
                  <TableHead>{t("wallet.colNote")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {b.entries.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell>{fmt(e.created_at)}</TableCell>
                    <TableCell>{t(KIND_KEY[e.kind])}</TableCell>
                    <TableCell className={e.amount_cents < 0 ? "text-destructive" : ""}>
                      ¥{signedYuan(e.amount_cents)}
                    </TableCell>
                    <TableCell>¥{yuan(e.balance_after_cents)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{e.out_trade_no ?? e.reason ?? ""}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {canWithdraw && <Withdrawals withdrawable={b.withdrawable_cents} />}
      </CardContent>
    </Card>
  );
}

function Withdrawals({ withdrawable }: { withdrawable: number }) {
  const t = useT();
  const fmt = useFmt();
  const queryClient = useQueryClient();
  const invite = useQuery({ queryKey: ["my-invite"], queryFn: () => get<MyInvite>("/me/invite") });
  const list = useQuery({ queryKey: ["my-withdrawals"], queryFn: () => get<Withdrawal[]>("/me/withdrawals") });
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<WithdrawMethod>("alipay");
  const [account, setAccount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const min = invite.data?.min_withdrawal_cents ?? 0;
  const rows = list.data ?? [];
  const open = rows.some((w) => w.status === "pending");

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["my-withdrawals"] }),
      queryClient.invalidateQueries({ queryKey: ["my-balance"] }),
      queryClient.invalidateQueries({ queryKey: ["my-invite"] }),
    ]);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setDone(false);
    const cents = parseYuan(amount);
    if (cents == null) return setError(t("wallet.badAmount"));
    setError(null);
    try {
      await post("/me/withdrawals", { amount_cents: cents, method, account: account.trim() });
      setAmount("");
      setDone(true);
      await refresh();
    } catch (err) {
      setError(errorText(err, t));
    }
  }

  async function cancel(id: string) {
    if (!window.confirm(t("wallet.confirmCancel"))) return;
    setError(null);
    try {
      await post(`/me/withdrawals/${id}/cancel`, {});
      await refresh();
    } catch (err) {
      setError(errorText(err, t));
    }
  }

  return (
    <div className="space-y-3">
      {(withdrawable > 0 || open) && (
        <form className="space-y-2" onSubmit={submit}>
          <h3 className="text-sm font-medium">{t("wallet.withdrawTitle")}</h3>
          <p className="text-xs text-muted-foreground">{t("wallet.withdrawHint", { min: yuan(min) })}</p>
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label htmlFor="w-amount">{t("wallet.amountLabel")}</Label>
              <Input
                id="w-amount"
                className="w-32"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="w-method">{t("wallet.methodLabel")}</Label>
              <select
                id="w-method"
                className="h-9 rounded-lg border border-border bg-background px-2 text-sm"
                value={method}
                onChange={(e) => setMethod(e.target.value as WithdrawMethod)}
              >
                {(Object.keys(METHOD_KEY) as WithdrawMethod[]).map((m) => (
                  <option key={m} value={m}>
                    {t(METHOD_KEY[m])}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="w-account">{t("wallet.accountLabel")}</Label>
              <Input
                id="w-account"
                className="w-64"
                maxLength={200}
                value={account}
                onChange={(e) => setAccount(e.target.value)}
              />
            </div>
            <Button type="submit" size="sm" disabled={open || !amount || !account.trim()}>
              {t("wallet.submit")}
            </Button>
          </div>
        </form>
      )}
      {done && (
        <p role="status" className="text-sm text-muted-foreground">
          {t("wallet.submitted")}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {rows.length > 0 && (
        <>
          <h3 className="text-sm font-medium">{t("wallet.withdrawalsTitle")}</h3>
          <div className="overflow-x-auto">
            <Table>
              <TableBody>
                {rows.map((w) => (
                  <TableRow key={w.id}>
                    <TableCell>{fmt(w.created_at)}</TableCell>
                    <TableCell>¥{yuan(w.amount_cents)}</TableCell>
                    <TableCell>{t(METHOD_KEY[w.method])}</TableCell>
                    <TableCell>
                      <Badge variant={w.status === "approved" ? "default" : "secondary"}>
                        {t(W_STATUS_KEY[w.status])}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {w.payout_reference ? t("wallet.reference", { ref: w.payout_reference }) : (w.note ?? "")}
                    </TableCell>
                    <TableCell>
                      {w.status === "pending" && (
                        <Button size="sm" variant="outline" onClick={() => void cancel(w.id)}>
                          {t("wallet.cancel")}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </div>
  );
}

function InviteCard() {
  const t = useT();
  const fmt = useFmt();
  const invite = useQuery({ queryKey: ["my-invite"], queryFn: () => get<MyInvite>("/me/invite") });
  const d = invite.data;
  if (!d) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t("invite.title")}</h2>
        </CardTitle>
        <CardDescription>
          {d.enabled
            ? `${t("invite.terms", { rate: d.rate_percent, days: d.hold_days })}${d.first_order_only ? ` ${t("invite.firstOnly")}` : ""}`
            : t("invite.disabled")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2 text-sm">
          <p className="font-medium">{t("invite.codes")}</p>
          {/* W15: create / copy link / delete (registration invite codes). */}
          <InviteCodes />
        </div>
        <div className="flex flex-wrap gap-4 text-sm">
          <span>{t("invite.invited", { count: d.invited_count })}</span>
          <span>{t("invite.pending", { amount: yuan(d.pending_cents) })}</span>
          <span>{t("invite.credited", { amount: yuan(d.credited_cents) })}</span>
        </div>
        <h3 className="text-sm font-medium">{t("invite.historyTitle")}</h3>
        {d.commissions.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("invite.historyEmpty")}</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("invite.colInvitee")}</TableHead>
                  <TableHead>{t("invite.colBase")}</TableHead>
                  <TableHead>{t("invite.colAmount")}</TableHead>
                  <TableHead>{t("invite.colStatus")}</TableHead>
                  <TableHead>{t("invite.colAvailable")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.commissions.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>{c.invitee_login}</TableCell>
                    <TableCell>¥{yuan(c.base_cents)}</TableCell>
                    <TableCell>
                      ¥{yuan(c.amount_cents)} ({c.rate_percent}%)
                    </TableCell>
                    <TableCell>
                      <Badge variant={c.status === "credited" ? "default" : "secondary"}>
                        {t(C_STATUS_KEY[c.status])}
                      </Badge>
                    </TableCell>
                    <TableCell>{fmt(c.status === "credited" ? c.credited_at : c.available_at)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
