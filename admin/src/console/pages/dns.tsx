// DNS (DNS-1..): the Cloudflare DNS of every zone the saved tokens can see.
// Nothing is stored here — zones and records are read live. `?zone=<account>:<zone>`
// picks the zone, `?q=` / `?type=` / `?page=` filter, `?tokens=1` opens the token
// dialog, `?new=1` the new-record dialog and `?edit=<id>` one record. Records the
// panel itself depends on carry a "面板使用中" badge; changing them asks first.
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { Cloud, CloudOff, Globe, KeyRound, Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { get, post } from "../../shared/api";
import { useLang, useTr } from "../../shared/i18n";
import { errorText } from "../../shared/errors";
import { Badge } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { useConfirm } from "../../shared/ui/confirm";
import { Select } from "../../shared/ui/form";
import { Banner, PageHeader } from "../../shared/ui/layout";
import { EmptyState } from "../../shared/ui/states";
import { DataTable, Pager, type Column } from "../../shared/ui/table";
import { useToast } from "../../shared/ui/toast";
import { SearchField } from "../components/kit";
import { useOwner } from "../components/settings-kit";
import { useAction } from "../data";
import {
  PER_PAGE,
  PROXIABLE,
  TYPES,
  contentText,
  parseZoneKey,
  recordsPath,
  ttlText,
  kindName,
  zoneKey,
  type BatchAnswer,
  type DnsRecord,
  type DnsZone,
  type PageInfo,
  type ZoneError,
} from "../dns-model";
import { useDebounced } from "../kit";
import { useQS } from "../router";
import { BatchIpDialog, BatchResultDialog, RecordDialog, TokensDialog, failureError, useGuarded } from "./dns-dialogs";

type Zones = { zones: DnsZone[]; errors: ZoneError[] };
type Records = { records: DnsRecord[]; page_info: PageInfo };

export function DnsPage() {
  const tr = useTr();
  const lang = useLang();
  const owner = useOwner();
  const toast = useToast();
  const confirm = useConfirm();
  const guarded = useGuarded();
  const [run] = useAction();
  const [query, patch] = useQS();
  const zonesQ = useQuery({ queryKey: ["dns-zones"], queryFn: () => get<Zones>("/dns/zones") });
  const zones = useMemo(() => zonesQ.data?.zones ?? [], [zonesQ.data]);
  const errors = zonesQ.data?.errors ?? [];
  const wanted = parseZoneKey(query.get("zone"));
  const zone = zones.find((z) => z.account_id === wanted?.account && z.id === wanted.zone) ?? zones[0] ?? null;
  const editable = zone?.can_edit !== false;

  const [search, setSearch] = useState(query.get("q") ?? "");
  const debounced = useDebounced(search, 300);
  useEffect(() => {
    if ((query.get("q") ?? "") !== debounced) patch({ q: debounced || null, page: null, edit: null }, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);
  const kind = query.get("type") ?? "";
  const page = Math.max(1, Number(query.get("page")) || 1);
  const recQ = useQuery({
    queryKey: ["dns-records", zone?.account_id, zone?.id, debounced, kind, page],
    enabled: !!zone,
    placeholderData: keepPreviousData,
    queryFn: () => {
      const p = new URLSearchParams({ page: String(page), per_page: String(PER_PAGE) });
      if (debounced) p.set("search", debounced);
      if (kind) p.set("type", kind);
      return get<Records>(`${recordsPath(zone!.account_id, zone!.id)}?${p}`);
    },
  });
  const records = recQ.data?.records ?? [];
  const info = recQ.data?.page_info;

  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => setSelected(new Set()), [zone?.id, debounced, kind, page]);
  const [result, setResult] = useState<BatchAnswer | null>(null);
  const [ipOpen, setIpOpen] = useState(false);
  const editing = records.find((r) => r.id === query.get("edit")) ?? null;
  const creating = query.get("new") === "1";
  const base = zone ? recordsPath(zone.account_id, zone.id) : "";

  const batch = async (body: Record<string, unknown>, verb: string) => {
    let answer: BatchAnswer | undefined;
    const done = await run(
      () =>
        guarded(async (c) => {
          answer = await post<BatchAnswer>(`${base}/batch`, { ...body, ids: [...selected], confirm: c });
        }, verb),
      { errorPrefix: tr("批量操作失败", "Batch failed") },
    );
    if (done && answer) {
      setSelected(new Set());
      setIpOpen(false);
      if (answer.failed > 0) setResult(answer);
      else toast({ tone: "success", title: tr(`已处理 ${answer.ok} 条记录`, `${answer.ok} records done`) });
    }
  };
  const batchDelete = async () => {
    const ok = await confirm({
      title: tr(`删除选中的 ${selected.size} 条记录？`, `Delete ${selected.size} records?`),
      description: tr(
        "记录会立即从 Cloudflare 删除，不能撤销。",
        "They are deleted from Cloudflare at once. This cannot be undone.",
      ),
      tone: "danger",
      typeToConfirm: String(selected.size),
      confirmLabel: tr("删除记录", "Delete records"),
    });
    if (ok) await batch({ action: "delete" }, tr("仍然删除", "Delete anyway"));
  };

  const cloud = (r: DnsRecord) =>
    PROXIABLE.includes(r.type) ? (
      <button
        type="button"
        disabled={!editable}
        aria-label={
          r.proxied
            ? tr("橙云：点击改为灰云", "Proxied: switch to DNS only")
            : tr("灰云：点击改为橙云", "DNS only: switch to proxied")
        }
        aria-pressed={!!r.proxied}
        data-testid={`dns-cloud-${r.name}`}
        onClick={(e) => {
          e.stopPropagation();
          void run(
            () =>
              guarded(
                (c) =>
                  post(`${base}/batch`, { action: "proxied", ids: [r.id], proxied: !r.proxied, confirm: c }).then(
                    (a) => {
                      const f = (a as BatchAnswer).results.find((x) => !x.ok);
                      if (f) throw failureError(f);
                    },
                  ),
                tr("仍然切换", "Switch anyway"),
              ),
            { errorPrefix: tr("切换失败", "Switch failed") },
          );
        }}
        className="hit-44 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-footnote disabled:opacity-50"
      >
        {r.proxied ? (
          <Cloud className="size-4 text-warning" aria-hidden="true" />
        ) : (
          <CloudOff className="size-4 text-faint" aria-hidden="true" />
        )}
        <span className={r.proxied ? "text-warning" : "text-muted-foreground"}>
          {r.proxied ? tr("已代理", "Proxied") : tr("仅 DNS", "DNS only")}
        </span>
      </button>
    ) : (
      <span className="text-faint">—</span>
    );

  const columns: Column<DnsRecord>[] = [
    { key: "type", header: tr("类型", "Type"), fixed: true, cell: (r) => <Badge tone="outline">{r.type}</Badge> },
    {
      key: "name",
      header: tr("名称", "Name"),
      fixed: true,
      mobile: "title",
      cell: (r) => (
        <span className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="font-mono break-all">{r.name}</span>
          {r.uses.length > 0 && (
            <Badge tone="warning" title={r.uses.map((u) => `${kindName(u.kind, tr)}: ${u.label}`).join("\n")}>
              {tr("面板使用中", "In use by panel")}
            </Badge>
          )}
        </span>
      ),
    },
    {
      key: "content",
      header: tr("内容", "Content"),
      cell: (r) => <span className="line-clamp-2 font-mono break-all">{contentText(r)}</span>,
    },
    { key: "cloud", header: tr("代理状态", "Proxy"), cell: cloud },
    { key: "ttl", header: "TTL", cell: (r) => <span className="tnum">{ttlText(r.ttl, tr)}</span> },
    {
      key: "comment",
      header: tr("备注", "Comment"),
      optional: true,
      mobile: "hide",
      cell: (r) => <span className="text-muted-foreground">{r.comment || "—"}</span>,
    },
  ];

  const actions = (
    <>
      <Button variant="outline" icon={KeyRound} onClick={() => patch({ tokens: "1" })} data-testid="dns-tokens">
        {tr("Cloudflare 令牌", "Tokens")}
      </Button>
      {zone && editable && (
        <Button variant="primary" icon={Plus} onClick={() => patch({ new: "1" })} data-testid="dns-new">
          {tr("新建记录", "New record")}
        </Button>
      )}
    </>
  );

  let body;
  if (zonesQ.isPending) body = <DataTable label={tr("DNS 记录", "DNS records")} rows={[]} columns={columns} loading />;
  else if (zonesQ.isError)
    body = (
      <DataTable
        label={tr("DNS 记录", "DNS records")}
        rows={[]}
        columns={columns}
        error={zonesQ.error}
        onRetry={() => void zonesQ.refetch()}
      />
    );
  else if (!zone)
    body = (
      <div className="rounded-xl bg-card shadow-card">
        <EmptyState
          icon={Globe}
          title={
            errors.length
              ? tr("没有可用的域名", "No zones available")
              : tr("还没有 Cloudflare 令牌", "No Cloudflare token yet")
          }
          description={
            owner
              ? tr(
                  "添加一个 API 令牌后，这里会列出它能管理的全部域名。",
                  "Add an API token and every zone it manages is listed here.",
                )
              : tr("需要所有者添加 Cloudflare 令牌。", "The owner has to add a Cloudflare token.")
          }
          action={
            owner ? (
              <Button variant="primary" icon={KeyRound} onClick={() => patch({ tokens: "1" })}>
                {tr("添加令牌", "Add token")}
              </Button>
            ) : undefined
          }
        />
      </div>
    );
  else
    body = (
      <DataTable
        label={tr("DNS 记录", "DNS records")}
        storageKey="dns"
        rows={records}
        columns={columns}
        loading={recQ.isPending}
        error={recQ.isError ? recQ.error : undefined}
        onRetry={() => void recQ.refetch()}
        selectable={editable}
        selected={selected}
        onSelectedChange={setSelected}
        onRowClick={(r) => patch({ edit: r.id })}
        activeId={editing?.id}
        filtered={!!debounced || !!kind}
        onClearFilters={() => {
          setSearch("");
          patch({ q: null, type: null, page: null });
        }}
        rowProps={(r) => ({ "data-name": r.name })}
        toolbar={
          <>
            <Select
              aria-label={tr("域名", "Zone")}
              value={zoneKey(zone.account_id, zone.id)}
              onChange={(e) => patch({ zone: e.target.value, page: null, q: null, type: null, edit: null })}
              className="w-56 max-sm:w-full"
              data-testid="dns-zone"
            >
              {[...new Set(zones.map((z) => z.account_id))].map((a) => (
                <optgroup key={a} label={zones.find((z) => z.account_id === a)?.account_name}>
                  {zones
                    .filter((z) => z.account_id === a)
                    .map((z) => (
                      <option key={z.id} value={zoneKey(z.account_id, z.id)}>
                        {z.name}
                      </option>
                    ))}
                </optgroup>
              ))}
            </Select>
            <SearchField
              className="w-52 max-sm:flex-1"
              label={tr("搜索名称或内容", "Search name or content")}
              value={search}
              onChange={setSearch}
              shortcut="/"
            />
            <Select
              aria-label={tr("类型", "Type")}
              value={kind}
              onChange={(e) => patch({ type: e.target.value || null, page: null })}
              className="w-28"
              data-testid="dns-type-filter"
            >
              <option value="">{tr("全部类型", "All types")}</option>
              {TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          </>
        }
        bulkActions={() => (
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void batch({ action: "proxied", proxied: true }, tr("仍然切换", "Switch anyway"))}
            >
              {tr("设为橙云", "Proxy")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void batch({ action: "proxied", proxied: false }, tr("仍然切换", "Switch anyway"))}
            >
              {tr("设为灰云", "DNS only")}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setIpOpen(true)}>
              {tr("更换 IP", "Change IP")}
            </Button>
            <Button size="sm" variant="destructive-soft" onClick={() => void batchDelete()}>
              {tr("删除", "Delete")}
            </Button>
          </>
        )}
        footer={
          info && (
            <Pager
              total={info.total_count}
              offset={(page - 1) * PER_PAGE}
              limit={PER_PAGE}
              onOffset={(o) => patch({ page: o === 0 ? null : String(Math.floor(o / PER_PAGE) + 1) })}
            />
          )
        }
      />
    );

  return (
    <>
      <PageHeader
        title={tr("DNS", "DNS")}
        description={tr(
          "管理 Cloudflare 上的解析记录；数据实时读取，面板不保存副本。",
          "Manage Cloudflare DNS records. Everything is read live; the panel keeps no copy.",
        )}
        actions={actions}
      />
      <div className="grid gap-3">
        {errors.map((e) => (
          <Banner
            key={e.account_id}
            tone="danger"
            title={tr(`令牌「${e.account_name}」`, `Token "${e.account_name}"`)}
            action={
              owner ? (
                <Button size="sm" variant="outline" onClick={() => patch({ tokens: "1" })}>
                  {tr("检查令牌", "Check token")}
                </Button>
              ) : undefined
            }
          >
            <span data-testid="dns-zone-error">{errorText(failureError(e), lang)}</span>
          </Banner>
        ))}
        {zone && !editable && (
          <Banner tone="info">
            {tr("这个令牌对该域名只有读取权限，不能修改记录。", "This token can only read this zone.")}
          </Banner>
        )}
        {body}
      </div>
      {zone && (creating || editing) && (
        <RecordDialog
          key={editing?.id ?? "new"}
          open
          onClose={() => patch({ new: null, edit: null })}
          zone={zone}
          record={editing}
          editable={editable}
        />
      )}
      <TokensDialog open={query.get("tokens") === "1"} onClose={() => patch({ tokens: null })} />
      <BatchIpDialog
        open={ipOpen}
        count={selected.size}
        onClose={() => setIpOpen(false)}
        onSubmit={(content) => batch({ action: "content", content }, tr("仍然更换", "Change anyway"))}
      />
      <BatchResultDialog answer={result} onClose={() => setResult(null)} />
    </>
  );
}
