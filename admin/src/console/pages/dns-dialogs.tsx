// DNS (DNS-*): the dialogs of the DNS page — one record (create / edit /
// delete), the Cloudflare tokens (owner), the new address for a batch and
// the per-record outcome of a batch. A write that touches a name the panel
// depends on answers 409 `dns.confirm_required` with the impact: `useGuarded`
// shows it in a confirmation and repeats the write with `confirm`.
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, KeyRound, Pencil, Plus, TestTube2, Trash2, XCircle } from "lucide-react";
import { useState, type ReactNode } from "react";
import { ApiError, del, get, post, put } from "../../shared/api";
import { errorText } from "../../shared/errors";
import { dateTime } from "../../shared/format";
import { useLang, useTr } from "../../shared/i18n";
import { Badge } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { Card } from "../../shared/ui/card";
import { useConfirm } from "../../shared/ui/confirm";
import { Dialog } from "../../shared/ui/dialog";
import { Field, Input, Select, SecretInput, Switch } from "../../shared/ui/form";
import { Banner } from "../../shared/ui/layout";
import { EmptyState, ErrorState, LoadingBlock } from "../../shared/ui/states";
import { useToast } from "../../shared/ui/toast";
import { FixCount } from "../components/kit";
import { OwnerNotice, useOwner } from "../components/settings-kit";
import { useAction } from "../data";
import {
  PROXIABLE,
  TTLS,
  TTL_AUTO,
  TYPES,
  bodyOf,
  draftErrors,
  draftOf,
  impactOf,
  recordsPath,
  ttlText,
  kindName,
  type BatchAnswer,
  type DnsAccount,
  type DnsFailure,
  type DnsRecord,
  type DnsZone,
  type Draft,
  type RType,
  type TestAnswer,
} from "../dns-model";

/** A failure the server reported inside a 200 answer, as an error `errorText` can map. */
export const failureError = (f: Partial<DnsFailure>) =>
  new ApiError(0, f.message ?? "", { code: f.code ?? "", params: f.params ?? {} });

/**
 * Run a write that may need the admin's confirmation: on `dns.confirm_required`
 * the impact is shown and the write repeated with `confirm = true`.
 * Resolves true when the write went through, false when the admin declined.
 */
export function useGuarded() {
  const tr = useTr();
  const confirm = useConfirm();
  return async (call: (confirm: boolean) => Promise<unknown>, verb: string): Promise<boolean> => {
    try {
      await call(false);
      return true;
    } catch (e) {
      if (!(e instanceof ApiError) || e.code !== "dns.confirm_required") throw e;
      return confirm({
        title: tr("这会影响面板自身的功能", "This affects the panel itself"),
        description: tr(
          "下面的域名正被面板使用。改动或删除后，依赖它们的功能（订阅、节点连接、证书、通行密钥）可能立即失效。",
          "The panel uses these names. Changing or deleting them can break what depends on them (subscriptions, node connections, certificates, passkeys) at once.",
        ),
        tone: "danger",
        impacts: impactOf(e.params).map((i) => ({
          label: <span className="font-mono">{i.name}</span>,
          value: i.uses.map((u) => u.label).join(tr("、", ", ")),
        })),
        confirmLabel: verb,
        action: () => call(true),
      });
    }
  };
}

/** The panel's dependencies on a record, as a list. */
function UsesBanner({ record }: { record: DnsRecord }) {
  const tr = useTr();
  if (record.uses.length === 0) return null;
  return (
    <Banner tone="warning" title={tr("面板使用中", "In use by the panel")}>
      {record.uses.map((u) => `${kindName(u.kind, tr)}: ${u.label}`).join(tr("、", ", "))}
    </Banner>
  );
}

/* ---------- Record ---------- */

function TtlSelect({ value, onChange, disabled }: { value: number; onChange: (n: number) => void; disabled: boolean }) {
  const tr = useTr();
  const options = TTLS.includes(value) ? TTLS : [...TTLS, value].sort((a, b) => a - b);
  return (
    <Select
      value={String(disabled ? TTL_AUTO : value)}
      disabled={disabled}
      onChange={(e) => onChange(Number(e.target.value))}
    >
      {options.map((n) => (
        <option key={n} value={n}>
          {ttlText(n, tr)}
        </option>
      ))}
    </Select>
  );
}

/** Create (`record` null) or edit one record; `zone` names the zone it lives in. */
export function RecordDialog({
  open,
  onClose,
  zone,
  record,
  editable,
  defaults,
}: {
  open: boolean;
  onClose: () => void;
  zone: DnsZone;
  record: DnsRecord | null;
  editable: boolean;
  /** Preset fields for a new record (e.g. an address from the linking buttons). */
  defaults?: Partial<Draft>;
}) {
  const tr = useTr();
  const toast = useToast();
  const guarded = useGuarded();
  const [run, busy] = useAction();
  const [draft, setDraft] = useState<Draft>(() => ({ ...draftOf(record ?? undefined, zone.name), ...defaults }));
  const [tried, setTried] = useState(false);
  const errs = draftErrors(draft, tr);
  const count = Object.keys(errs).length;
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const base = recordsPath(zone.account_id, zone.id);
  const proxiable = PROXIABLE.includes(draft.type);
  const show = (k: keyof typeof errs) => (tried ? errs[k] : undefined);
  const save = async () => {
    setTried(true);
    if (count > 0) return;
    const done = await run(
      () =>
        guarded(
          (confirm) =>
            record ? put(`${base}/${record.id}`, bodyOf(draft, confirm)) : post(base, bodyOf(draft, confirm)),
          tr("仍然保存", "Save anyway"),
        ),
      { errorPrefix: tr("保存失败", "Save failed") },
    );
    if (done) {
      toast({ tone: "success", title: record ? tr("记录已保存", "Record saved") : tr("记录已创建", "Record created") });
      onClose();
    }
  };
  const remove = async () => {
    if (!record) return;
    const done = await run(
      () =>
        guarded(
          (confirm) => del(`${base}/${record.id}${confirm ? "?confirm=true" : ""}`),
          tr("仍然删除", "Delete anyway"),
        ),
      { errorPrefix: tr("删除失败", "Delete failed") },
    );
    if (done) {
      toast({ tone: "success", title: tr("记录已删除", "Record deleted") });
      onClose();
    }
  };
  const confirm = useConfirm();
  const askRemove = async () => {
    if (!record) return;
    const ok = await confirm({
      title: tr(`删除 ${record.name}？`, `Delete ${record.name}?`),
      description: tr(
        "记录会立即从 Cloudflare 删除，解析随之失效。不能撤销。",
        "The record is deleted from Cloudflare at once and stops resolving. This cannot be undone.",
      ),
      impacts: [
        { label: tr("类型", "Type"), value: record.type },
        { label: tr("内容", "Content"), value: <span className="font-mono">{record.content || "—"}</span> },
      ],
      tone: "danger",
      confirmLabel: tr("删除记录", "Delete record"),
    });
    if (ok) await remove();
  };
  const t = draft.type;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="md"
      icon={record ? Pencil : Plus}
      title={record ? tr("编辑 DNS 记录", "Edit DNS record") : tr("新建 DNS 记录", "New DNS record")}
      description={zone.name}
      onSubmit={() => void save()}
      footer={
        <>
          {record && editable ? (
            <Button variant="destructive-soft" icon={Trash2} onClick={() => void askRemove()}>
              {tr("删除", "Delete")}
            </Button>
          ) : (
            <Button variant="ghost" onClick={onClose}>
              {tr("取消", "Cancel")}
            </Button>
          )}
          <div className="ml-auto flex items-center gap-2">
            {record && editable && (
              <Button variant="ghost" onClick={onClose}>
                {tr("取消", "Cancel")}
              </Button>
            )}
            {tried && <FixCount n={count} />}
            {editable && (
              <Button type="submit" variant="primary" loading={busy}>
                {record ? tr("保存", "Save") : tr("创建记录", "Create record")}
              </Button>
            )}
          </div>
        </>
      }
    >
      <fieldset disabled={!editable} className="grid min-w-0 gap-4">
        {record && <UsesBanner record={record} />}
        <div className="grid gap-3 sm:grid-cols-[120px_minmax(0,1fr)]">
          <Field label={tr("类型", "Type")}>
            <Select value={t} onChange={(e) => set("type", e.target.value as RType)} data-testid="dns-type">
              {TYPES.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label={tr("名称", "Name")}
            required
            error={show("name")}
            hint={tr("完整域名，或 @ 表示根域名", "A full name, or @ for the zone apex")}
          >
            <Input data-autofocus value={draft.name} onChange={(e) => set("name", e.target.value)} placeholder="www" />
          </Field>
        </div>
        {(t === "A" || t === "AAAA" || t === "CNAME" || t === "TXT" || t === "NS" || t === "MX") && (
          <Field
            label={
              t === "A"
                ? tr("IPv4 地址", "IPv4 address")
                : t === "AAAA"
                  ? tr("IPv6 地址", "IPv6 address")
                  : t === "TXT"
                    ? tr("内容", "Content")
                    : tr("目标主机", "Target host")
            }
            required
            error={show("content")}
          >
            <Input
              className="font-mono"
              value={draft.content}
              onChange={(e) => set("content", e.target.value)}
              placeholder={t === "A" ? "203.0.113.10" : t === "AAAA" ? "2001:db8::10" : ""}
            />
          </Field>
        )}
        {t === "MX" && (
          <Field
            label={tr("优先级", "Priority")}
            error={show("priority")}
            hint={tr("数字越小越优先", "Lower is preferred")}
          >
            <Input inputMode="numeric" value={draft.priority} onChange={(e) => set("priority", e.target.value)} />
          </Field>
        )}
        {t === "SRV" && (
          <div className="grid gap-3 sm:grid-cols-3">
            {(
              [
                ["service", tr("服务", "Service"), "_sip"],
                ["proto", tr("协议", "Protocol"), "_tcp"],
                ["name", tr("域名", "Name"), ""],
              ] as const
            ).map(([k, label, ph]) => (
              <Field key={k} label={label}>
                <Input
                  value={draft.srv[k]}
                  placeholder={ph}
                  onChange={(e) => set("srv", { ...draft.srv, [k]: e.target.value })}
                />
              </Field>
            ))}
            {(
              [
                ["priority", tr("优先级", "Priority")],
                ["weight", tr("权重", "Weight")],
                ["port", tr("端口", "Port")],
              ] as const
            ).map(([k, label]) => (
              <Field
                key={k}
                label={label}
                error={k === "port" ? show("port") : k === "priority" ? show("priority") : undefined}
              >
                <Input
                  inputMode="numeric"
                  value={draft.srv[k]}
                  onChange={(e) => set("srv", { ...draft.srv, [k]: e.target.value })}
                />
              </Field>
            ))}
            <Field className="sm:col-span-3" label={tr("目标主机", "Target host")} error={show("target")}>
              <Input
                className="font-mono"
                value={draft.srv.target}
                onChange={(e) => set("srv", { ...draft.srv, target: e.target.value })}
              />
            </Field>
          </div>
        )}
        {t === "CAA" && (
          <div className="grid gap-3 sm:grid-cols-[90px_140px_minmax(0,1fr)]">
            <Field label={tr("标志", "Flags")}>
              <Input
                inputMode="numeric"
                value={draft.caa.flags}
                onChange={(e) => set("caa", { ...draft.caa, flags: e.target.value })}
              />
            </Field>
            <Field label={tr("标记", "Tag")}>
              <Select value={draft.caa.tag} onChange={(e) => set("caa", { ...draft.caa, tag: e.target.value })}>
                {["issue", "issuewild", "iodef"].map((x) => (
                  <option key={x} value={x}>
                    {x}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={tr("值", "Value")} error={show("value")}>
              <Input
                className="font-mono"
                value={draft.caa.value}
                onChange={(e) => set("caa", { ...draft.caa, value: e.target.value })}
              />
            </Field>
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label={tr("TTL", "TTL")}
            hint={
              draft.proxied && proxiable ? tr("橙云记录固定为自动", "Proxied records are always automatic") : undefined
            }
          >
            <TtlSelect value={draft.ttl} onChange={(n) => set("ttl", n)} disabled={proxiable && draft.proxied} />
          </Field>
          {proxiable && (
            <Field label={tr("Cloudflare 代理（橙云）", "Cloudflare proxy (orange cloud)")} group>
              <div className="flex h-8 items-center gap-2 pointer-coarse:h-10">
                <Switch
                  checked={draft.proxied}
                  onChange={(v) => set("proxied", v)}
                  label={tr("Cloudflare 代理", "Cloudflare proxy")}
                />
                <span className="text-footnote text-muted-foreground">
                  {draft.proxied ? tr("已代理（橙云）", "Proxied (orange)") : tr("仅 DNS（灰云）", "DNS only (grey)")}
                </span>
              </div>
            </Field>
          )}
        </div>
        <Field label={tr("备注", "Comment")} error={show("comment")}>
          <Input value={draft.comment} onChange={(e) => set("comment", e.target.value)} />
        </Field>
      </fieldset>
    </Dialog>
  );
}

/* ---------- Batch ---------- */

/** The new address for the selected A / AAAA records. */
export function BatchIpDialog({
  open,
  count,
  onClose,
  onSubmit,
}: {
  open: boolean;
  count: number;
  onClose: () => void;
  onSubmit: (content: string) => Promise<unknown>;
}) {
  const tr = useTr();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const v = value.trim();
  const valid = /^[0-9a-fA-F:.]+$/.test(v) && (v.includes(":") || v.split(".").length === 4);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="sm"
      title={tr("批量更换 IP", "Change the address")}
      description={tr(`${count} 条记录`, `${count} records`)}
      onSubmit={() => {
        if (!valid) return;
        setBusy(true);
        void onSubmit(v).finally(() => setBusy(false));
      }}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {tr("取消", "Cancel")}
          </Button>
          <Button type="submit" variant="primary" className="ml-auto" loading={busy} disabled={!valid}>
            {tr("更换", "Change")}
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <Field
          label={tr("新地址", "New address")}
          hint={tr(
            "IPv4 只会写入 A 记录，IPv6 只会写入 AAAA 记录；类型不符的记录会跳过并说明原因。",
            "An IPv4 address goes to A records, an IPv6 one to AAAA records; others are skipped with a reason.",
          )}
        >
          <Input data-autofocus className="font-mono" value={value} onChange={(e) => setValue(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

/** What a batch did to each record. */
export function BatchResultDialog({ answer, onClose }: { answer: BatchAnswer | null; onClose: () => void }) {
  const tr = useTr();
  const lang = useLang();
  return (
    <Dialog
      open={!!answer}
      onClose={onClose}
      size="md"
      title={tr("批量操作结果", "Batch result")}
      description={
        answer
          ? tr(
              `成功 ${answer.ok} 条，失败或跳过 ${answer.failed} 条`,
              `${answer.ok} done, ${answer.failed} failed or skipped`,
            )
          : undefined
      }
      footer={
        <Button variant="primary" className="ml-auto" onClick={onClose}>
          {tr("好", "OK")}
        </Button>
      }
    >
      <ul className="divide-y divide-separator" data-testid="dns-batch-results">
        {answer?.results.map((r) => (
          <li key={r.id} className="flex items-start gap-2 py-2">
            {r.ok ? (
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
            ) : (
              <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
            )}
            <div className="min-w-0">
              <div className="truncate font-mono text-body">{r.name ?? r.id}</div>
              {!r.ok && <div className="text-footnote text-muted-foreground">{errorText(failureError(r), lang)}</div>}
            </div>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

/* ---------- Tokens ---------- */

type Editing = { id: string | null; name: string; token: string } | null;

function TestLine({ answer }: { answer: TestAnswer }) {
  const tr = useTr();
  const lang = useLang();
  if (!answer.ok)
    return (
      <Banner tone="danger" className="mt-2">
        {errorText(failureError(answer), lang)}
      </Banner>
    );
  return (
    <Banner tone="success" className="mt-2">
      <span data-testid="dns-test-ok">
        {tr(
          `连接正常：${answer.zones} 个域名，${answer.editable} 个可编辑`,
          `Connected: ${answer.zones} zones, ${answer.editable} editable`,
        )}
        {answer.read_only > 0 && tr(`，${answer.read_only} 个只读`, `, ${answer.read_only} read-only`)}
        {answer.sample.length > 0 && ` — ${answer.sample.slice(0, 5).join(", ")}${answer.zones > 5 ? "…" : ""}`}
      </span>
    </Banner>
  );
}

/** The Cloudflare API tokens (the owner adds, replaces and removes; admins see and test them). */
export function TokensDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const tr = useTr();
  const owner = useOwner();
  const confirm = useConfirm();
  const toast = useToast();
  const [run, busy] = useAction();
  const [editing, setEditing] = useState<Editing>(null);
  const [tests, setTests] = useState<Record<string, TestAnswer | "busy">>({});
  const q = useQuery({
    queryKey: ["dns-accounts"],
    queryFn: () => get<{ accounts: DnsAccount[] }>("/dns/accounts"),
    enabled: open,
  });
  const accounts = q.data?.accounts ?? [];
  const nameErr = editing && (editing.name.trim().length < 1 || editing.name.trim().length > 64);
  const tokenErr = editing && editing.id === null && editing.token.trim().length < 20;
  const save = async () => {
    if (!editing || nameErr || tokenErr) return;
    const body: Record<string, unknown> = { name: editing.name.trim() };
    if (editing.token.trim()) body.token = editing.token.trim();
    const old = accounts.find((a) => a.id === editing.id);
    if (old) body.version = old.version;
    const done = await run(
      () => (editing.id ? put(`/dns/accounts/${editing.id}`, body) : post("/dns/accounts", body)),
      {
        errorPrefix: tr("保存失败", "Save failed"),
      },
    );
    if (done) {
      toast({ tone: "success", title: tr("令牌已保存", "Token saved") });
      setEditing(null);
    }
  };
  const test = async (a: DnsAccount) => {
    setTests((t) => ({ ...t, [a.id]: "busy" }));
    try {
      const r = await post<TestAnswer>(`/dns/accounts/${a.id}/test`);
      setTests((t) => ({ ...t, [a.id]: r }));
    } catch (e) {
      const err = e as ApiError;
      setTests((t) => ({ ...t, [a.id]: { ok: false, code: err.code, message: err.message, params: err.params } }));
    }
  };
  const remove = async (a: DnsAccount) => {
    const ok = await confirm({
      title: tr(`删除令牌「${a.name}」？`, `Delete the token "${a.name}"?`),
      description: tr(
        "只删除面板里保存的令牌；Cloudflare 上的记录和令牌本身不受影响（要作废令牌请去 Cloudflare 控制台）。",
        "Only the token stored in the panel is deleted; Cloudflare records and the token itself stay (revoke the token in the Cloudflare dashboard).",
      ),
      typeToConfirm: a.name,
      tone: "danger",
      confirmLabel: tr("删除令牌", "Delete token"),
      action: () => del(`/dns/accounts/${a.id}`),
    });
    if (ok) toast({ tone: "success", title: tr("令牌已删除", "Token deleted") });
  };
  let body: ReactNode;
  if (q.isPending) body = <LoadingBlock rows={2} />;
  else if (q.isError) body = <ErrorState error={q.error} onRetry={() => void q.refetch()} compact />;
  else
    body = (
      <div className="grid gap-3">
        {!owner && <OwnerNotice what={tr("Cloudflare 令牌", "The Cloudflare tokens")} />}
        {accounts.length === 0 && !editing && (
          <EmptyState
            icon={KeyRound}
            title={tr("还没有 Cloudflare 令牌", "No Cloudflare token yet")}
            description={tr(
              "添加一个只有「区域 · DNS · 编辑」权限的 API 令牌，面板就能管理这些域名的解析。",
              "Add an API token with only Zone · DNS · Edit and the panel can manage those zones.",
            )}
          />
        )}
        {accounts.map((a) => (
          <Card key={a.id} className="p-3" data-testid={`dns-account-${a.name}`}>
            <div className="flex flex-wrap items-center gap-2">
              <KeyRound className="size-4 text-faint" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-body font-medium">{a.name}</span>
              <Badge tone="neutral" className="font-mono">
                {a.fingerprint}
              </Badge>
              <span className="text-footnote text-faint">{dateTime(a.updated_at)}</span>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                icon={TestTube2}
                loading={tests[a.id] === "busy"}
                onClick={() => void test(a)}
              >
                {tr("测试连接", "Test connection")}
              </Button>
              {owner && (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    icon={Pencil}
                    onClick={() => setEditing({ id: a.id, name: a.name, token: "" })}
                  >
                    {tr("编辑", "Edit")}
                  </Button>
                  <Button size="sm" variant="destructive-soft" icon={Trash2} onClick={() => void remove(a)}>
                    {tr("删除", "Delete")}
                  </Button>
                </>
              )}
            </div>
            {tests[a.id] && tests[a.id] !== "busy" && <TestLine answer={tests[a.id] as TestAnswer} />}
          </Card>
        ))}
        {editing && owner && (
          <Card className="grid gap-3 p-3">
            <Field
              label={tr("名称", "Name")}
              required
              error={nameErr ? tr("1-64 个字符", "1-64 characters") : undefined}
            >
              <Input
                data-autofocus
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                placeholder={tr("例如：主账号", "e.g. main account")}
              />
            </Field>
            <Field
              label={tr("API 令牌", "API token")}
              required={editing.id === null}
              error={editing.token && tokenErr ? tr("令牌太短", "The token is too short") : undefined}
              hint={
                editing.id
                  ? tr("留空 = 保持原令牌不变", "Leave empty to keep the stored token")
                  : tr(
                      "只写不读：保存后不再显示。建议只授予「区域 · DNS · 编辑」。",
                      "Write-only: never shown again. Grant only Zone · DNS · Edit.",
                    )
              }
            >
              <SecretInput
                className="font-mono"
                value={editing.token}
                onChange={(e) => setEditing({ ...editing, token: e.target.value })}
              />
            </Field>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setEditing(null)}>
                {tr("取消", "Cancel")}
              </Button>
              <Button variant="primary" loading={busy} disabled={!!nameErr || !!tokenErr} onClick={() => void save()}>
                {tr("保存令牌", "Save token")}
              </Button>
            </div>
          </Card>
        )}
      </div>
    );
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="md"
      icon={KeyRound}
      title={tr("Cloudflare 令牌", "Cloudflare tokens")}
      description={tr("令牌加密保存，只有所有者能修改", "Tokens are stored encrypted; only the owner can change them")}
      dirty={false}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {tr("关闭", "Close")}
          </Button>
          {owner && !editing && (
            <Button
              className="ml-auto"
              variant="primary"
              icon={Plus}
              onClick={() => setEditing({ id: null, name: "", token: "" })}
            >
              {tr("添加令牌", "Add token")}
            </Button>
          )}
        </>
      }
    >
      {body}
    </Dialog>
  );
}
