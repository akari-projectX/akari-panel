// DNS linking (DNS-07..): next to the names the panel itself uses (site
// domains, a server's certificate domain, direct entrances' connect hosts)
// show what Cloudflare has for them and offer one-click fixes: "point at this
// panel" / "point at this server", node domains back to grey cloud, and the
// panel's own public addresses (owner). All writes are the `/dns/link*`
// endpoints (the same audit and confirmation rules as the DNS page).
import { useQuery } from "@tanstack/react-query";
import { Cloud, CloudOff, Globe, Link2, Pencil } from "lucide-react";
import { useState } from "react";
import { get, post, put } from "../../shared/api";
import { errorText } from "../../shared/errors";
import { useLang, useTr } from "../../shared/i18n";
import { Badge } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { Card } from "../../shared/ui/card";
import { Dialog } from "../../shared/ui/dialog";
import { Field, Input } from "../../shared/ui/form";
import { Banner } from "../../shared/ui/layout";
import { useToast } from "../../shared/ui/toast";
import { useOwner } from "../components/settings-kit";
import { SECONDARY, useAction } from "../data";
import { recordsPath, type DnsFailure } from "../dns-model";
import { failureError, useGuarded } from "./dns-dialogs";

export type PanelAddr = { version: number; public_ipv4: string | null; public_ipv6: string | null };
export type HostState = {
  host: string;
  uses: { kind: string; label: string }[];
  zone: {
    account_id: string;
    account_name: string;
    zone_id: string;
    zone_name: string;
    can_edit: boolean | null;
  } | null;
  records: { id: string; type: string; content: string; proxied: boolean | null; ttl: number }[];
  error?: DnsFailure;
  not_a_name?: boolean;
};
type LinkAnswer = {
  ok: number;
  failed: number;
  address?: string;
  results: ({ host: string; ok: boolean } & Partial<DnsFailure>)[];
};
type Item = { host: string; address?: string; proxied?: boolean };

/** The site domains with their Cloudflare records (GET /dns/domains). */
export function useDnsDomains() {
  return useQuery({
    queryKey: ["dns-domains"],
    queryFn: () => get<{ panel: PanelAddr; hosts: HostState[]; errors: unknown[] }>("/dns/domains"),
    staleTime: 30_000,
    meta: SECONDARY,
  });
}

/** The writes: link names, link a server, switch records to grey. Each resolves true when something was written. */
function useLinkActions() {
  const tr = useTr();
  const lang = useLang();
  const toast = useToast();
  const guarded = useGuarded();
  const [run, busy] = useAction();
  const report = (a: LinkAnswer) => {
    const bad = a.results.find((r) => !r.ok);
    if (bad) toast({ tone: "error", title: `${bad.host}: ${errorText(failureError(bad), lang)}` });
    else toast({ tone: "success", title: tr("解析已更新", "DNS updated") });
  };
  const linkAt = async (path: string, body: Record<string, unknown>) => {
    let answer: LinkAnswer | undefined;
    const done = await run(
      () =>
        guarded(
          async (confirm) => {
            answer = await post<LinkAnswer>(path, { ...body, confirm });
          },
          tr("仍然修改", "Change anyway"),
        ),
      { errorPrefix: tr("设置解析失败", "DNS update failed") },
    );
    if (done && answer) report(answer);
    return !!done && !!answer && answer.failed === 0;
  };
  return {
    busy,
    link: (items: Item[]) => linkAt("/dns/link", { hosts: items }),
    linkServer: (id: string, address?: string) => linkAt(`/dns/link/server/${id}`, address ? { address } : {}),
    grey: async (h: HostState) => {
      if (!h.zone) return false;
      const ids = h.records.filter((r) => r.proxied).map((r) => r.id);
      const done = await run(
        () =>
          guarded(
            (confirm) =>
              post(`${recordsPath(h.zone!.account_id, h.zone!.zone_id)}/batch`, {
                action: "proxied",
                proxied: false,
                ids,
                confirm,
              }),
            tr("仍然切换", "Switch anyway"),
          ),
        { errorPrefix: tr("切换失败", "Switch failed"), ok: tr("已改为灰云", "Switched to DNS only") },
      );
      return !!done;
    },
  };
}

/** "A 203.0.113.5 · 仅 DNS" chips of a name's records. */
function RecordChips({ h }: { h: HostState }) {
  const tr = useTr();
  if (h.records.length === 0)
    return (
      <span className="text-muted-foreground">{tr("Cloudflare 上还没有解析记录", "No record at Cloudflare yet")}</span>
    );
  return (
    <>
      {h.records.map((r) => (
        <Badge key={r.id} tone={r.proxied ? "warning" : "neutral"} className="font-mono" data-testid="dns-record-chip">
          {r.proxied ? <Cloud className="fill-current" aria-hidden="true" /> : <CloudOff aria-hidden="true" />}
          {r.type} {r.content}
        </Badge>
      ))}
    </>
  );
}

/** The panel's public IPv4 / IPv6 (owner): what "point at this panel" uses. */
function PanelAddressDialog({
  open,
  onClose,
  panel,
}: {
  open: boolean;
  onClose: () => void;
  panel: PanelAddr | undefined;
}) {
  const tr = useTr();
  const toast = useToast();
  const [run, busy] = useAction();
  const [v4, setV4] = useState(panel?.public_ipv4 ?? "");
  const [v6, setV6] = useState(panel?.public_ipv6 ?? "");
  const save = async () => {
    const done = await run(
      () =>
        put("/settings/public-addresses", {
          version: panel?.version ?? 0,
          public_ipv4: v4.trim(),
          public_ipv6: v6.trim(),
        }),
      { errorPrefix: tr("保存失败", "Save failed") },
    );
    if (done !== undefined) {
      toast({ tone: "success", title: tr("面板地址已保存", "Panel addresses saved") });
      onClose();
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="sm"
      icon={Globe}
      title={tr("面板的公网地址", "The panel's public addresses")}
      description={tr("「指向本面板」会把域名解析到这里", '"Point at this panel" resolves names to these')}
      onSubmit={() => void save()}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {tr("取消", "Cancel")}
          </Button>
          <Button type="submit" variant="primary" className="ml-auto" loading={busy}>
            {tr("保存", "Save")}
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <Field label="IPv4" hint={tr("留空 = 不设置", "Empty = not set")}>
          <Input
            data-autofocus
            className="font-mono"
            value={v4}
            onChange={(e) => setV4(e.target.value)}
            placeholder="203.0.113.10"
          />
        </Field>
        <Field label="IPv6" hint={tr("只接受公网地址", "Public addresses only")}>
          <Input className="font-mono" value={v6} onChange={(e) => setV6(e.target.value)} placeholder="2001:db8::10" />
        </Field>
      </div>
    </Dialog>
  );
}

/** The DNS line under a site domain: its records and the one-click fixes. */
export function DomainDns({
  kind,
  state,
  panel,
}: {
  kind: string;
  state: HostState | undefined;
  panel: PanelAddr | undefined;
}) {
  const tr = useTr();
  const owner = useOwner();
  const lang = useLang();
  const actions = useLinkActions();
  const [editing, setEditing] = useState(false);
  if (!state?.zone || state.not_a_name) return null;
  const set = !!(panel?.public_ipv4 || panel?.public_ipv6);
  const editable = state.zone.can_edit !== false;
  const proxied = state.records.some((r) => r.proxied);
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-footnote" data-testid={`dns-link-${state.host}`}>
      <Link2 className="size-3.5 text-faint" aria-hidden="true" />
      <span className="text-muted-foreground">Cloudflare · {state.zone.zone_name}</span>
      {state.error ? (
        <span className="text-destructive">{errorText(failureError(state.error), lang)}</span>
      ) : (
        <RecordChips h={state} />
      )}
      <span className="flex-1" />
      {editable && set && (
        <Button
          size="sm"
          variant="outline"
          loading={actions.busy}
          onClick={() => void actions.link([{ host: state.host }])}
        >
          {tr("指向本面板", "Point at this panel")}
        </Button>
      )}
      {editable && !set && owner && (
        <Button size="sm" variant="outline" icon={Pencil} onClick={() => setEditing(true)}>
          {tr("设置面板地址", "Set panel address")}
        </Button>
      )}
      {editable && kind === "node" && proxied && (
        <Button size="sm" variant="destructive-soft" loading={actions.busy} onClick={() => void actions.grey(state)}>
          {tr("改为灰云", "Switch to DNS only")}
        </Button>
      )}
      {editing && <PanelAddressDialog open onClose={() => setEditing(false)} panel={panel} />}
    </div>
  );
}

/** Server settings: the certificate domain and direct entrance hosts of this server. */
export function ServerDns({ id }: { id: string }) {
  const tr = useTr();
  const actions = useLinkActions();
  const [moved, setMoved] = useState(false);
  const [address, setAddress] = useState("");
  const q = useQuery({
    queryKey: ["dns-server", id],
    queryFn: () =>
      get<{ address: string | null; hosts: HostState[]; skipped: string[]; errors: unknown[] }>(
        `/dns/link/server/${id}`,
      ),
    meta: SECONDARY,
  });
  const d = q.data;
  if (!d || d.hosts.length === 0 || d.hosts.every((h) => !h.zone)) return null;
  const typed = address.trim();
  const sep = tr("、", ", ");
  return (
    <Card className="overflow-hidden" data-testid="server-dns">
      <div className="grid gap-3 px-4 py-4">
        <div>
          <div className="text-headline font-semibold">{tr("DNS 解析", "DNS records")}</div>
          <p className="text-footnote text-muted-foreground">
            {tr(
              "证书域名与直连入口的连接域名，一律灰云。机器换了 IP 后在这里一键更新。",
              "The certificate domain and the connect domains of direct entrances, always grey cloud. Update them here after the machine changes IP.",
            )}
          </p>
        </div>
        {d.hosts.map((h) => (
          <div
            key={h.host}
            className="flex flex-wrap items-center gap-1.5 text-footnote"
            data-testid={`server-dns-${h.host}`}
          >
            <span className="font-mono text-body font-medium">{h.host}</span>
            {h.zone ? (
              <RecordChips h={h} />
            ) : (
              <span className="text-muted-foreground">
                {tr("不在任何令牌管理的区域", "Not in a zone any token manages")}
              </span>
            )}
          </div>
        ))}
        {d.skipped.length > 0 && (
          <p className="text-footnote text-muted-foreground">
            {tr(
              `直接用 IP 的连接地址不需要解析：${d.skipped.join(sep)}`,
              `Connect addresses that are IPs need no record: ${d.skipped.join(sep)}`,
            )}
          </p>
        )}
        {moved && (
          <Field
            label={tr("新的 IP 地址", "The new IP address")}
            hint={tr("留空 = 用 agent 连接面板的来源地址", "Empty = the address the agent connects from")}
          >
            <Input
              className="font-mono"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder={d.address ?? ""}
            />
          </Field>
        )}
        {!d.address && !moved && (
          <Banner tone="info">
            {tr(
              "还不知道这台服务器的公网地址，点「IP 变了」手动填写。",
              'The server\'s public address is not known yet: use "IP changed" and type it.',
            )}
          </Banner>
        )}
        <div className="flex flex-wrap gap-2">
          {d.address && !moved && (
            <Button variant="outline" loading={actions.busy} onClick={() => void actions.linkServer(id)}>
              {tr(`指向 ${d.address}`, `Point at ${d.address}`)}
            </Button>
          )}
          {!moved ? (
            <Button variant="outline" onClick={() => setMoved(true)}>
              {tr("IP 变了…", "IP changed…")}
            </Button>
          ) : (
            <>
              <Button
                variant="primary"
                loading={actions.busy}
                disabled={!typed && !d.address}
                onClick={() =>
                  void actions.linkServer(id, typed || undefined).then((ok) => ok && (setMoved(false), setAddress("")))
                }
              >
                {tr("更新全部解析", "Update all records")}
              </Button>
              <Button variant="ghost" onClick={() => setMoved(false)}>
                {tr("取消", "Cancel")}
              </Button>
            </>
          )}
        </div>
      </div>
    </Card>
  );
}
