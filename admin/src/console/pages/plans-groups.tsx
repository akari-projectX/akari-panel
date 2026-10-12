// 节点组 (/plans/groups, NOD-21; proposal-v2 §3 节点组): cards that draw
// what each group holds (servers → entrance chips), which plans use it and
// how many subscribe; the editor (lg dialog) with a searchable entrance
// picker grouped by server; delete with the impact and the group's name.
import { ArrowUpRight, Layers, Pencil, Plus, Server, Trash2, Waypoints } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { del, patch, post } from "../../shared/api";
import { cn } from "../../shared/cn";
import { useTr } from "../../shared/i18n";
import { Button } from "../../shared/ui/button";
import { Card } from "../../shared/ui/card";
import { useConfirm } from "../../shared/ui/confirm";
import { Dialog } from "../../shared/ui/dialog";
import { Checkbox, Field, Input } from "../../shared/ui/form";
import { MenuItem, MenuSeparator, RowMenu } from "../../shared/ui/menu";
import { EmptyState, ErrorState, Skeleton } from "../../shared/ui/states";
import { useToast } from "../../shared/ui/toast";
import {
  byServer,
  entrancesOf,
  groupFacts,
  groupSubscribers,
  rateText,
  useEntranceIndex,
  type EntranceInfo,
} from "../components/commerce-plans";
import { EntranceChip, FixCount, IconBadge, SearchField } from "../components/kit";
import { useAction } from "../data";
import { setQuery } from "../router";
import { useGroups, usePlanList, useServers } from "../servers";
import type { NodeGroup, PlanView } from "../types";

/** The delete confirmation of a group (menu and editor share it). */
export function useDeleteGroup() {
  const tr = useTr();
  const confirm = useConfirm();
  const toast = useToast();
  return async (g: NodeGroup, plans: PlanView[], groups: NodeGroup[]): Promise<boolean> => {
    const using = plans.filter((p) => p.group_ids.includes(g.id));
    const others = groups.filter((x) => x.id !== g.id);
    const onlyFromIt = using.filter(
      (p) =>
        entrancesOf(
          p.group_ids.filter((x) => x !== g.id),
          others,
        ).length === 0,
    ).length;
    const ok = await confirm({
      title: tr(`删除节点组「${g.name}」？`, `Delete node group "${g.name}"?`),
      description: using.length
        ? tr(
            "使用它的套餐会失去这些入口；如果这是套餐唯一的节点组，用户会连不上任何节点。",
            "Plans using it lose these entrances; where it is a plan's only group, its users reach no node at all.",
          )
        : tr("没有套餐使用这个组，删除不影响用户。", "No plan uses this group: deleting it affects nobody."),
      impacts: [
        {
          label: tr("使用它的套餐", "Plans using it"),
          value: using.length ? using.map((p) => p.name).join("、") : tr("无", "None"),
        },
        {
          label: tr("受影响的订阅", "Subscriptions affected"),
          value: tr(`${groupSubscribers(g, plans).toLocaleString()} 位`, groupSubscribers(g, plans).toLocaleString()),
        },
        {
          label: tr("仅靠它拿到入口的套餐", "Plans that get entrances only from it"),
          value: tr(`${onlyFromIt} 个`, String(onlyFromIt)),
        },
      ],
      typeToConfirm: g.name,
      confirmLabel: tr("删除节点组", "Delete group"),
      action: () => del(`/node-groups/${g.id}`),
    });
    if (ok) toast({ tone: "success", title: tr("节点组已删除", "Node group deleted") });
    return ok;
  };
}

export function NodeGroupsView({ open }: { open: string | null }) {
  const tr = useTr();
  const groups = useGroups();
  const servers = useServers();
  const plans = usePlanList();
  const idx = useEntranceIndex(servers.data);
  const remove = useDeleteGroup();
  if (groups.isError)
    return (
      <Card>
        <ErrorState
          title={tr("节点组加载失败", "Node groups failed to load")}
          error={groups.error}
          onRetry={() => void groups.refetch()}
        />
      </Card>
    );
  if (groups.isPending)
    return (
      <div className="grid gap-3 lg:grid-cols-2" role="status" aria-label={tr("加载中", "Loading")}>
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-52 rounded-xl" />
        ))}
      </div>
    );
  const list = groups.data;
  const planList = plans.data ?? [];
  const grouped = new Set(list.flatMap((g) => g.entrance_ids));
  const loose = [...idx.values()].filter((e) => e.enabled && !grouped.has(e.id)).length;
  const editing = open === "new" ? null : (list.find((g) => g.id === open) ?? undefined);
  return (
    <>
      {list.length === 0 ? (
        <Card>
          <EmptyState
            icon={Waypoints}
            title={tr("还没有节点组", "No node groups yet")}
            description={tr(
              "节点组把一组入口打包，套餐选择节点组来决定用户能连哪些节点。比如「标准」= 各地直连，「专业」= 直连 + 中转。",
              'A node group bundles entrances; plans pick groups to decide which nodes their users reach. E.g. "Standard" = direct entrances, "Pro" = direct + relays.',
            )}
            action={
              <Button variant="primary" icon={Plus} onClick={() => setQuery({ open: "new" }, false)}>
                {tr("新建节点组", "New node group")}
              </Button>
            }
          />
        </Card>
      ) : (
        <>
          <div className="grid gap-3 lg:grid-cols-2">
            {list.map((g) => (
              <GroupCard
                key={g.id}
                g={g}
                idx={idx}
                plans={planList}
                onEdit={() => setQuery({ open: g.id }, false)}
                onDelete={() => void remove(g, planList, list)}
              />
            ))}
          </div>
          {loose > 0 && (
            <p className="mt-3 px-1 text-footnote text-faint">
              {tr(
                `有 ${loose} 个入口不在任何节点组里，用户拿不到它们。`,
                `${loose} entrances are in no node group: no user gets them.`,
              )}
            </p>
          )}
        </>
      )}
      {open && editing !== undefined && (
        <GroupEditor
          key={open}
          group={editing}
          groups={list}
          plans={planList}
          idx={idx}
          onClose={() => setQuery({ open: null })}
        />
      )}
    </>
  );
}

function GroupCard({
  g,
  idx,
  plans,
  onEdit,
  onDelete,
}: {
  g: NodeGroup;
  idx: Map<string, EntranceInfo>;
  plans: PlanView[];
  onEdit: () => void;
  onDelete: () => void;
}) {
  const tr = useTr();
  const f = groupFacts(g, idx);
  const rows = byServer(g.entrance_ids, idx);
  const using = plans.filter((p) => p.group_ids.includes(g.id));
  const subs = groupSubscribers(g, plans);
  return (
    <section aria-label={g.name}>
      <Card className="flex h-full flex-col">
        <div className="flex items-start gap-3 px-4 pt-3.5">
          <IconBadge icon={Waypoints} size="sm" />
          <div className="min-w-0 flex-1">
            <button
              type="button"
              onClick={onEdit}
              className="max-w-full truncate text-left text-headline font-semibold tracking-[-0.01em] hover:underline"
            >
              {g.name}
            </button>
            {g.description && <p className="truncate text-footnote text-muted-foreground">{g.description}</p>}
          </div>
          <RowMenu label={tr(`节点组 ${g.name} 的操作`, `Actions of ${g.name}`)}>
            {(close) => (
              <>
                <MenuItem icon={Pencil} onClick={() => (close(), onEdit())}>
                  {tr("编辑", "Edit")}
                </MenuItem>
                <MenuSeparator />
                <MenuItem icon={Trash2} danger onClick={() => (close(), onDelete())}>
                  {tr("删除", "Delete")}
                </MenuItem>
              </>
            )}
          </RowMenu>
        </div>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 px-4 text-footnote text-muted-foreground">
          <span>
            <b className="tnum font-semibold text-foreground">{f.count}</b> {tr("个入口", "entrances")}
          </span>
          <span>
            <b className="tnum font-semibold text-foreground">{f.servers}</b> {tr("台服务器", "servers")}
          </span>
          <span>
            <b className="tnum font-semibold text-foreground">{f.relays}</b> {tr("个中转", "relays")}
          </span>
        </div>
        <div className="mt-3 grid gap-2 px-4" aria-label={tr(`${g.name} 的入口`, `Entrances of ${g.name}`)}>
          {rows.length === 0 && <p className="text-footnote text-warning">{tr("没有入口", "No entrances")}</p>}
          {rows.map((r) => (
            <div key={r.serverId} className="flex items-start gap-2 max-sm:flex-col max-sm:gap-1">
              <Link
                to={`/nodes/${r.serverId}`}
                className="flex w-32 shrink-0 items-center gap-1 pt-0.5 text-footnote font-medium hover:text-primary max-sm:w-auto"
              >
                <Server className="size-3.5 shrink-0 text-faint" aria-hidden="true" />
                <span className="truncate">{r.serverName}</span>
              </Link>
              <div className="flex min-w-0 flex-wrap gap-1">
                {r.list.map((e) => (
                  <EntranceChip
                    key={e.id}
                    name={e.name}
                    kind={e.kind}
                    rate={rateText(e.rate)}
                    muted={!e.enabled || e.hidden}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="min-h-3 flex-1" />
        <div className="flex flex-wrap items-center gap-1.5 border-t border-separator px-4 py-2.5 text-footnote">
          {using.length === 0 ? (
            <span className="text-faint">{tr("还没有套餐使用这个组", "No plan uses this group yet")}</span>
          ) : (
            <>
              <span className="text-muted-foreground">{tr("用于", "Used by")}</span>
              {using.map((p) => (
                <Link
                  key={p.id}
                  to={`/plans?open=${p.id}&tab=groups`}
                  className="hit-44 inline-flex h-6 max-w-full items-center gap-1 rounded-full bg-secondary px-2 font-medium hover:bg-accent"
                >
                  <Layers className="size-3 shrink-0 text-faint" aria-hidden="true" />
                  <span className="truncate">{p.name}</span>
                </Link>
              ))}
              <span className="tnum ml-auto text-muted-foreground">
                {tr(`${subs.toLocaleString()} 位订阅`, `${subs.toLocaleString()} subscribers`)}
              </span>
            </>
          )}
        </div>
      </Card>
    </section>
  );
}

/**
 * New / edit a node group (lg dialog). `onSaved` gets the group's id (the
 * plan editor ticks a group created from inside it).
 */
export function GroupEditor({
  group,
  groups,
  plans,
  idx,
  onClose,
  onSaved,
}: {
  group: NodeGroup | null;
  groups: NodeGroup[];
  plans: PlanView[];
  idx: Map<string, EntranceInfo>;
  onClose: () => void;
  onSaved?: (id: string) => void;
}) {
  const tr = useTr();
  const [name, setName] = useState(group?.name ?? "");
  const [desc, setDesc] = useState(group?.description ?? "");
  const [sel, setSel] = useState<string[]>(group?.entrance_ids ?? []);
  const [q, setQ] = useState("");
  const [tried, setTried] = useState(false);
  const [run, busy] = useAction();
  const all = [...idx.values()];
  const t = q.trim().toLowerCase();
  const shown = all.filter(
    (e) =>
      !t ||
      [e.name, e.full, e.serverName, e.host ?? "", ...e.tags].some((x) => x.toLowerCase().includes(t)) ||
      (e.port !== null && String(e.port).includes(t)),
  );
  const rows = byServer(
    shown.map((e) => e.id),
    idx,
  );
  const nameErr = !name.trim()
    ? tr("必填", "Required")
    : groups.some((g) => g.name === name.trim() && g.id !== group?.id)
      ? tr("已有同名节点组", "A node group with this name exists")
      : undefined;
  // An empty group is allowed (filled later), but said plainly.
  const selWarn =
    sel.length === 0 && all.length > 0
      ? tr("还没选入口：使用这个组的套餐拿不到任何入口", "No entrance chosen: plans using this group get none")
      : undefined;
  const errs = [nameErr].filter(Boolean).length;
  const using = group ? plans.filter((p) => p.group_ids.includes(group.id)) : [];
  const subs = group ? groupSubscribers(group, plans) : 0;
  const selServers = new Set(sel.map((id) => idx.get(id)?.serverId).filter(Boolean)).size;
  const groupName = new Map(groups.map((g) => [g.id, g.name]));
  const dirty =
    name !== (group?.name ?? "") ||
    desc !== (group?.description ?? "") ||
    [...sel].sort().join() !== [...(group?.entrance_ids ?? [])].sort().join();
  const toggle = (ids: string[], on: boolean) =>
    setSel((s) => (on ? [...new Set([...s, ...ids])] : s.filter((x) => !ids.includes(x))));
  const submit = async () => {
    setTried(true);
    if (errs) return;
    const b = { name: name.trim(), description: desc, entrance_ids: sel };
    const r = await run(
      () => (group ? patch<{ id: string }>(`/node-groups/${group.id}`, b) : post<{ id: string }>("/node-groups", b)),
      { ok: tr("节点组已保存", "Node group saved") },
    );
    if (r === undefined) return;
    onSaved?.(r.id);
    onClose();
  };
  return (
    <Dialog
      open
      size="lg"
      icon={Waypoints}
      onClose={onClose}
      onSubmit={submit}
      dirty={dirty}
      title={
        group
          ? tr(`编辑节点组「${group.name}」`, `Edit node group "${group.name}"`)
          : tr("新建节点组", "New node group")
      }
      description={
        using.length
          ? tr(
              `改动会立即影响 ${using.map((p) => p.name).join("、")} 的 ${subs.toLocaleString()} 位用户（订阅刷新后生效）`,
              `Changes reach the ${subs.toLocaleString()} users of ${using.map((p) => p.name).join(", ")} at once (after their subscription refreshes)`,
            )
          : tr("把一组入口打包，供套餐选择", "Bundle entrances for plans to choose")
      }
      footer={
        <>
          <span className="mr-auto text-footnote text-muted-foreground" role="status">
            {tr("已选 ", "")}
            <b className="tnum font-semibold text-foreground">{sel.length}</b>
            {tr(` 个入口，来自 ${selServers} 台服务器`, ` entrances from ${selServers} servers`)}
          </span>
          {tried && <FixCount n={errs} />}
          <Button onClick={onClose} variant="ghost" className="max-sm:hidden">
            {tr("取消", "Cancel")}
          </Button>
          <Button type="submit" variant="primary" loading={busy} disabled={tried && errs > 0}>
            {group ? tr("保存", "Save") : tr("创建", "Create")}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <div className="grid gap-3 sm:grid-cols-[200px_minmax(0,1fr)]">
          <Field label={tr("名称", "Name")} required error={tried ? nameErr : undefined}>
            <Input
              data-autofocus
              value={name}
              placeholder={tr("例如：专业", "e.g. Pro")}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label={tr("说明", "Description")} hint={tr("只在后台显示", "Shown in the console only")}>
            <Input value={desc} onChange={(e) => setDesc(e.target.value)} />
          </Field>
        </div>
        <div>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <h4 className="text-footnote font-semibold text-muted-foreground">{tr("入口", "Entrances")}</h4>
            {selWarn && <span className="text-footnote text-warning">{selWarn}</span>}
            {all.length > 0 && (
              <SearchField
                value={q}
                onChange={setQ}
                label={tr("搜索入口", "Search entrances")}
                placeholder={tr("搜索入口、服务器、地址、标签", "Search entrance, server, address, tag")}
                className="ml-auto w-64 max-sm:w-full"
              />
            )}
          </div>
          {all.length === 0 ? (
            <p className="rounded-xl bg-window px-4 py-6 text-center text-body text-muted-foreground ring-1 ring-border ring-inset">
              {tr("还没有服务器和入口。", "No servers or entrances yet.")}
            </p>
          ) : rows.length === 0 ? (
            <p className="rounded-xl bg-window px-4 py-6 text-center text-body text-muted-foreground ring-1 ring-border ring-inset">
              {tr(`没有匹配「${q}」的入口。`, `No entrance matches "${q}". `)}
              <button type="button" className="text-primary hover:underline" onClick={() => setQ("")}>
                {tr("清除搜索", "Clear search")}
              </button>
            </p>
          ) : (
            <div className="grid gap-2">
              {rows.map((r) => {
                const ids = r.list.map((e) => e.id);
                const n = ids.filter((x) => sel.includes(x)).length;
                const total = all.filter((e) => e.serverId === r.serverId).length;
                return (
                  <section key={r.serverId} className="overflow-hidden rounded-xl ring-1 ring-border ring-inset">
                    <label className="flex min-h-11 items-center gap-3 bg-window px-3 py-2">
                      <Checkbox
                        checked={n > 0 && n === ids.length}
                        indeterminate={n > 0 && n < ids.length}
                        label={tr(`全选 ${r.serverName}`, `All of ${r.serverName}`)}
                        onChange={() => toggle(ids, n < ids.length)}
                      />
                      <Server className="size-4 shrink-0 text-faint" aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate text-body font-semibold">{r.serverName}</span>
                      <span className="tnum text-footnote text-muted-foreground">
                        {n} / {t ? tr(`${ids.length}（共 ${total}）`, `${ids.length} (of ${total})`) : total}
                      </span>
                    </label>
                    <ul className="divide-y divide-separator">
                      {r.list.map((e) => {
                        const also = e.groupIds
                          .filter((x) => x !== group?.id)
                          .map((x) => groupName.get(x))
                          .filter(Boolean);
                        return (
                          <li key={e.id}>
                            <label className="flex min-h-11 items-center gap-3 px-3 py-1.5 pl-9 hover:bg-accent max-sm:pl-3">
                              <Checkbox
                                checked={sel.includes(e.id)}
                                label={e.full}
                                onChange={(on) => toggle([e.id], on)}
                              />
                              <span className="min-w-0 flex-1">
                                <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                                  <EntranceChip
                                    name={e.name}
                                    kind={e.kind}
                                    rate={rateText(e.rate)}
                                    muted={!e.enabled || e.hidden}
                                  />
                                  {e.tags.map((x) => (
                                    <span key={x} className="text-caption text-faint">
                                      {x}
                                    </span>
                                  ))}
                                  {!e.enabled && (
                                    <span className="text-caption text-faint">{tr("已停用", "disabled")}</span>
                                  )}
                                </span>
                                <span className="mt-0.5 block truncate font-mono text-caption text-faint">
                                  {e.host ?? tr("节点地址", "node address")}
                                  {e.port !== null ? `:${e.port}` : ""}
                                </span>
                              </span>
                              {also.length > 0 && (
                                <span className="shrink-0 text-footnote text-muted-foreground max-sm:hidden">
                                  {tr(`也在 ${also.join("、")}`, `Also in ${also.join(", ")}`)}
                                </span>
                              )}
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                );
              })}
            </div>
          )}
          <Link
            to="/nodes"
            className={cn(
              "mt-2 inline-flex items-center gap-0.5 px-1 text-footnote font-medium text-primary hover:underline",
            )}
          >
            {tr("在节点页添加入口", "Add entrances on the nodes page")}
            <ArrowUpRight className="size-3" aria-hidden="true" />
          </Link>
        </div>
      </div>
    </Dialog>
  );
}
