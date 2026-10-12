// 系统设置 → 通用：站点与品牌 (SET-01, SET-24) and 域名与证书 (SET-02…05,
// SET-27 passkey centre, the Cloudflare ranges of SET-09). Domain entries
// are added in a dialog; every change goes through the save bar, which
// lists the impact of removed domains (typed confirmation), and confirms a
// new time zone and a new passkey centre.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleCheck, GripVertical, Plus, Radar, Star, Trash2, TriangleAlert } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { del, get, post, put, putBinary } from "../../shared/api";
import { prefixBase } from "../../shared/base";
import { dateTime } from "../../shared/format";
import { useTr, type Tr } from "../../shared/i18n";
import { Badge } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { Group } from "../../shared/ui/card";
import { useConfirm } from "../../shared/ui/confirm";
import { Dialog } from "../../shared/ui/dialog";
import { Field, Input, Select, Textarea } from "../../shared/ui/form";
import { MenuItem, MenuSeparator, RowMenu } from "../../shared/ui/menu";
import { useToast } from "../../shared/ui/toast";
import { settled, useAction } from "../data";
import { Mono, useErrText } from "../kit";
import { fresh, type SettingsView, useSettings } from "./settings-data";
import {
  DangerZone,
  FieldRow,
  InfoRow,
  Loaded,
  SwitchRow,
  TimeZonePicker,
  Warnings,
  domainError,
  lines,
  useDraft,
  useSavePart,
} from "./settings-kit";

// ---------------------------------------------------------------------------
// 站点与品牌
// ---------------------------------------------------------------------------

type Branding = {
  version: number;
  logo_url: string | null;
  favicon_url: string | null;
  footer_text: string | null;
  footer_links: { label: string; url: string }[];
  tos_url: string | null;
  privacy_url: string | null;
  client_downloads: { platform: string; label: string | null; url: string }[];
};
const PLATFORMS: [string, string, string][] = [
  ["windows", "Windows", "Windows"],
  ["macos", "macOS", "macOS"],
  ["linux", "Linux", "Linux"],
  ["android", "Android", "Android"],
  ["ios", "iOS", "iOS"],
  ["harmony", "鸿蒙", "HarmonyOS"],
  ["other", "其他", "Other"],
];

/** A link of the portal footer: https, http or a same-site path. */
function linkError(raw: string, tr: Tr, blankOk: boolean): string | undefined {
  const v = raw.trim();
  if (!v) return blankOk ? undefined : tr("请填写链接", "Enter a link");
  if (v.startsWith("/") && !v.startsWith("//")) return undefined;
  try {
    const u = new URL(v);
    if (u.protocol === "https:" || u.protocol === "http:") return undefined;
  } catch {
    /* below */
  }
  return tr("请输入 https:// 开头的地址或以 / 开头的站内路径", "Enter an https:// address or a path starting with /");
}

export function SiteSection() {
  const s = useSettings();
  const branding = useQuery({
    queryKey: ["settings", "branding"],
    queryFn: () => get<Branding>("/settings/branding"),
  });
  return (
    <>
      <Loaded q={s} rows={3}>
        {(d) => <SiteForm d={d} />}
      </Loaded>
      <Loaded q={branding}>{(b) => <BrandingForm b={b} />}</Loaded>
    </>
  );
}

function SiteForm({ d }: { d: SettingsView }) {
  const tr = useTr();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [run] = useAction();
  const f = useDraft({ name: d.site_name ?? "", tz: d.timezone.value ?? "" });
  const v = f.value!;
  const nameError = v.name.trim().length > 64 ? tr("最多 64 个字符", "At most 64 characters") : undefined;
  useSavePart({
    count: f.edited.length,
    errors: nameError ? 1 : 0,
    discard: f.reset,
    save: async () => {
      if (f.isEdited("tz")) {
        const zone = v.tz || d.timezone.default;
        const ok = await confirm({
          title: tr(`把站点时区改为 ${zone}？`, `Change the site time zone to ${zone}?`),
          impact: tr("之后的日界按新时区计算", "From now on days are cut in the new time zone"),
          description: tr(
            "流量明细与拦截统计的日、套餐月重置、日历月时长、仪表盘与 CSV 导出的日期都从下一次写入起按新时区计算；已有的记录不改。",
            "The days of traffic history and block counts, monthly resets, calendar-month terms, the dashboard and CSV dates follow the new zone from the next write; existing records stay as they are.",
          ),
          tone: "warning",
          confirmLabel: tr("确认修改时区", "Change the time zone"),
        });
        if (!ok) return false;
      }
      const cur = fresh(qc, ["settings"], d);
      const r = await run(
        () =>
          put("/settings/site", {
            version: cur.version,
            site_name: v.name.trim() || null,
            timezone: v.tz || null,
          }),
        { ok: tr("站点设置已保存", "Site settings saved") },
      );
      if (r === undefined) return false;
      f.reset();
      return true;
    },
  });
  return (
    <Group
      title={tr("站点", "Site")}
      footer={tr(
        "站点名称用于邮件、页面标题与门户；时区决定流量明细、套餐月重置、仪表盘与导出的日界。",
        "The site name appears in mail, page titles and the portal; the time zone cuts the days of traffic history, monthly resets, the dashboard and exports.",
      )}
    >
      <FieldRow label={tr("站点名称", "Site name")} description={tr("留空 = Akari", "Empty = Akari")} error={nameError}>
        {(a) => (
          <Input
            {...a}
            className="sm:w-64"
            placeholder="Akari"
            value={v.name}
            onChange={(e) => f.set("name", e.target.value)}
          />
        )}
      </FieldRow>
      <FieldRow
        label={tr("站点时区", "Site time zone")}
        description={tr(`当前生效：${d.timezone.effective}`, `In effect: ${d.timezone.effective}`)}
      >
        {(a) => (
          <TimeZonePicker aria={a} value={v.tz} defaultZone={d.timezone.default} onChange={(z) => f.set("tz", z)} />
        )}
      </FieldRow>
    </Group>
  );
}

type BrandingForm = Pick<Branding, "footer_text" | "footer_links" | "tos_url" | "privacy_url" | "client_downloads">;

function BrandingForm({ b }: { b: Branding }) {
  const tr = useTr();
  const qc = useQueryClient();
  const [run] = useAction();
  const f = useDraft<BrandingForm>({
    footer_text: b.footer_text ?? "",
    footer_links: b.footer_links,
    tos_url: b.tos_url ?? "",
    privacy_url: b.privacy_url ?? "",
    client_downloads: b.client_downloads.map((x) => ({ ...x, label: x.label ?? "" })),
  });
  const v = f.value!;
  const tosError = linkError(v.tos_url ?? "", tr, true);
  const privacyError = linkError(v.privacy_url ?? "", tr, true);
  const linkErrors = v.footer_links.map((l) => ({
    label: l.label.trim() ? undefined : tr("请填写文字", "Enter a label"),
    url: linkError(l.url, tr, false),
  }));
  const dlErrors = v.client_downloads.map((l) => linkError(l.url, tr, false));
  const errors =
    [tosError, privacyError, ...dlErrors].filter(Boolean).length +
    linkErrors.reduce((n, e) => n + (e.label ? 1 : 0) + (e.url ? 1 : 0), 0);
  useSavePart({
    count: f.edited.length,
    errors,
    discard: f.reset,
    save: async () => {
      const cur = fresh(qc, ["settings", "branding"], b);
      const r = await run(
        () =>
          put("/settings/branding", {
            version: cur.version,
            footer_text: v.footer_text?.trim() || null,
            footer_links: v.footer_links.map((l) => ({ label: l.label.trim(), url: l.url.trim() })),
            tos_url: v.tos_url?.trim() || null,
            privacy_url: v.privacy_url?.trim() || null,
            client_downloads: v.client_downloads.map((l) => ({
              platform: l.platform,
              label: l.label?.trim() || null,
              url: l.url.trim(),
            })),
          }),
        { ok: tr("品牌设置已保存", "Branding saved") },
      );
      if (r === undefined) return false;
      f.reset();
      return true;
    },
  });
  const links = v.footer_links;
  const dls = v.client_downloads;
  return (
    <>
      <Group
        title={tr("Logo 与网站图标", "Logo and favicon")}
        footer={tr(
          "仅 PNG：Logo 不超过 2048 像素、256 KB；网站图标不超过 256 像素、64 KB。上传与删除立即生效。",
          "PNG only: the logo up to 2048 px and 256 KB, the favicon up to 256 px and 64 KB. Uploads and removals apply at once.",
        )}
      >
        <ImageRow name="logo" url={b.logo_url} label={tr("Logo", "Logo")} />
        <ImageRow name="favicon" url={b.favicon_url} label={tr("网站图标", "Favicon")} />
      </Group>
      <Group title={tr("页脚与链接", "Footer and links")}>
        <FieldRow label={tr("页脚文字", "Footer text")}>
          {(a) => (
            <Input
              {...a}
              className="sm:w-72"
              value={v.footer_text ?? ""}
              onChange={(e) => f.set("footer_text", e.target.value)}
            />
          )}
        </FieldRow>
        <FieldRow
          label={tr("服务条款链接", "Terms link")}
          description={tr("留空 = 门户自带的条款页", "Empty = the portal's own page")}
          error={tosError}
        >
          {(a) => (
            <Input
              {...a}
              className="sm:w-72"
              value={v.tos_url ?? ""}
              onChange={(e) => f.set("tos_url", e.target.value)}
            />
          )}
        </FieldRow>
        <FieldRow
          label={tr("隐私政策链接", "Privacy link")}
          description={tr("留空 = 门户自带的隐私页", "Empty = the portal's own page")}
          error={privacyError}
        >
          {(a) => (
            <Input
              {...a}
              className="sm:w-72"
              value={v.privacy_url ?? ""}
              onChange={(e) => f.set("privacy_url", e.target.value)}
            />
          )}
        </FieldRow>
        <div className="grid gap-2 px-4 py-2.5">
          <div className="text-body font-medium">{tr("页脚链接", "Footer links")}</div>
          {links.map((l, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)_auto] sm:items-start">
              <div>
                <Input
                  aria-label={tr("文字", "Label")}
                  aria-invalid={linkErrors[i].label ? true : undefined}
                  value={l.label}
                  onChange={(e) =>
                    f.set(
                      "footer_links",
                      links.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)),
                    )
                  }
                />
                {linkErrors[i].label && <p className="mt-1 text-footnote text-destructive">{linkErrors[i].label}</p>}
              </div>
              <div>
                <Input
                  aria-label={tr("链接地址", "Link URL")}
                  aria-invalid={linkErrors[i].url ? true : undefined}
                  value={l.url}
                  onChange={(e) =>
                    f.set(
                      "footer_links",
                      links.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)),
                    )
                  }
                />
                {linkErrors[i].url && <p className="mt-1 text-footnote text-destructive">{linkErrors[i].url}</p>}
              </div>
              <Button
                size="icon-sm"
                variant="ghost"
                icon={Trash2}
                aria-label={tr(`删除页脚链接 ${i + 1}`, `Remove footer link ${i + 1}`)}
                onClick={() =>
                  f.set(
                    "footer_links",
                    links.filter((_, j) => j !== i),
                  )
                }
              />
            </div>
          ))}
          <div>
            <Button
              size="sm"
              variant="soft"
              icon={Plus}
              onClick={() => f.set("footer_links", [...links, { label: "", url: "" }])}
            >
              {tr("添加链接", "Add link")}
            </Button>
          </div>
        </div>
      </Group>
      <Group
        title={tr("客户端下载链接", "Client downloads")}
        footer={tr("显示在门户的「下载客户端」里。", "Listed under the portal's client downloads.")}
      >
        <div className="grid gap-2 px-4 py-2.5">
          {dls.length === 0 && (
            <p className="text-footnote text-muted-foreground">{tr("还没有下载链接。", "No downloads yet.")}</p>
          )}
          {dls.map((l, i) => (
            <div
              key={i}
              className="grid gap-2 sm:grid-cols-[minmax(0,8rem)_minmax(0,9rem)_minmax(0,1fr)_auto] sm:items-start"
            >
              <Select
                aria-label={tr("平台", "Platform")}
                value={l.platform}
                onChange={(e) =>
                  f.set(
                    "client_downloads",
                    dls.map((x, j) => (j === i ? { ...x, platform: e.target.value } : x)),
                  )
                }
              >
                {PLATFORMS.map(([id, zh, en]) => (
                  <option key={id} value={id}>
                    {tr(zh, en)}
                  </option>
                ))}
              </Select>
              <Input
                aria-label={tr("名称（可选）", "Label (optional)")}
                value={l.label ?? ""}
                onChange={(e) =>
                  f.set(
                    "client_downloads",
                    dls.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)),
                  )
                }
              />
              <div>
                <Input
                  aria-label={tr("下载地址", "Download URL")}
                  aria-invalid={dlErrors[i] ? true : undefined}
                  value={l.url}
                  onChange={(e) =>
                    f.set(
                      "client_downloads",
                      dls.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)),
                    )
                  }
                />
                {dlErrors[i] && <p className="mt-1 text-footnote text-destructive">{dlErrors[i]}</p>}
              </div>
              <Button
                size="icon-sm"
                variant="ghost"
                icon={Trash2}
                aria-label={tr(`删除下载链接 ${i + 1}`, `Remove download ${i + 1}`)}
                onClick={() =>
                  f.set(
                    "client_downloads",
                    dls.filter((_, j) => j !== i),
                  )
                }
              />
            </div>
          ))}
          <div>
            <Button
              size="sm"
              variant="soft"
              icon={Plus}
              onClick={() => f.set("client_downloads", [...dls, { platform: "windows", label: "", url: "" }])}
            >
              {tr("添加下载", "Add download")}
            </Button>
          </div>
        </div>
      </Group>
    </>
  );
}

function ImageRow({ name, url, label }: { name: "logo" | "favicon"; url: string | null; label: string }) {
  const tr = useTr();
  const confirm = useConfirm();
  const [run, busy] = useAction();
  return (
    <InfoRow label={label} description={url ? undefined : tr("未设置", "Not set")}>
      {url && (
        <img
          src={`${prefixBase}/${url}`}
          alt={label}
          className="size-10 rounded-md bg-window object-contain ring-1 ring-border"
        />
      )}
      <Button size="sm" variant="outline" asChild>
        <label className={busy ? "pointer-events-none opacity-50" : "cursor-pointer"}>
          {url ? tr("更换", "Replace") : tr("上传", "Upload")}
          <input
            type="file"
            accept="image/png"
            className="sr-only"
            aria-label={tr(`上传${label}（PNG）`, `Upload ${label} (PNG)`)}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file)
                void run(() => putBinary(`/settings/branding/${name}`, file, "image/png"), {
                  ok: tr("已上传", "Uploaded"),
                });
            }}
          />
        </label>
      </Button>
      {url && (
        <Button
          size="sm"
          variant="destructive-soft"
          aria-label={tr(`删除${label}`, `Remove the ${label}`)}
          onClick={() =>
            void confirm({
              title: tr(`删除${label}？`, `Remove the ${label}?`),
              description: tr("门户与邮件改回默认样式。", "The portal and mail fall back to the default."),
              confirmLabel: tr("删除", "Remove"),
              action: () => del(`/settings/branding/${name}`),
            })
          }
        >
          {tr("删除", "Remove")}
        </Button>
      )}
    </InfoRow>
  );
}

// ---------------------------------------------------------------------------
// 域名与证书
// ---------------------------------------------------------------------------

type Kind = "main" | "sub" | "node";
const kindName = (k: Kind, tr: Tr) =>
  ({
    main: tr("主域名", "Main domains"),
    sub: tr("订阅域名", "Subscription domains"),
    node: tr("节点通信域名", "Node communication domains"),
  })[k];
const kindOne = (k: Kind, tr: Tr) =>
  ({
    main: tr("主域名", "main domain"),
    sub: tr("订阅域名", "subscription domain"),
    node: tr("节点通信域名", "node domain"),
  })[k];

type Impact = {
  removed: {
    kind: string;
    domain: string;
    preferred: boolean;
    places: { what: string; count: number; detail?: string }[];
  }[];
};

function placeText(p: { what: string; count: number; detail?: string }, tr: Tr) {
  switch (p.what) {
    case "portal_console":
      return tr("门户、后台与管理接口不再在此域名上提供", "The portal, console and admin API stop answering on it");
    case "links":
      return p.count
        ? tr("邮件、安装与支付链接改用下一个主域名", "Mail, install and payment links move to the next main domain")
        : tr(
            "没有剩下的主域名：邮件、安装与支付链接不可用",
            "No main domain left: mail, install and payment links stop",
          );
    case "pending_orders":
      return tr(`${p.count} 个待付订单的支付回调`, `Payment notices of ${p.count} pending orders`);
    case "install_links":
      return tr(`${p.count} 个未使用的安装链接`, `${p.count} unused install links`);
    case "subscription_links":
      return tr(`${p.count} 个用户的订阅链接`, `Subscription links of ${p.count} users`);
    case "nodes":
      return tr(
        `${p.count} 台已注册服务器连接此域名（继续工作）`,
        `${p.count} enrolled servers dial it (they keep working)`,
      );
    default:
      return tr(`其他影响：${p.count}`, `Other: ${p.count}`);
  }
}

type DomainForm = { main: string[]; sub: string[]; node: string[]; perUser: boolean; trust: string };

const domainBase = (d: SettingsView): DomainForm => ({
  main: d.main.domains.map((x) => x.domain),
  sub: d.sub.domains.map((x) => x.domain),
  node: d.node.domains.map((x) => x.domain),
  perUser: d.sub_domain_per_user,
  trust: d.trust_cloudflare.value === null ? "" : String(d.trust_cloudflare.value),
});

export function DomainsSection() {
  const s = useSettings();
  return <Loaded q={s}>{(d) => <Domains d={d} />}</Loaded>;
}

function Domains({ d }: { d: SettingsView }) {
  const tr = useTr();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const errText = useErrText();
  const [checks, setChecks] = useState<Record<string, { tone: "success" | "warning" | "neutral"; text: string }>>({});
  const f = useDraft(domainBase(d));
  const v = f.value!;

  const putDomains = async (force: boolean, hostChange: boolean, removal: boolean): Promise<boolean> => {
    const cur = fresh(qc, ["settings"], d);
    try {
      await put("/settings", {
        version: cur.version,
        main_domains: v.main,
        sub_domains: v.sub,
        node_domains: v.node,
        sub_domain_per_user: v.perUser,
        trust_cloudflare: v.trust === "" ? null : v.trust === "true",
        force_node_cloudflare: force,
        confirm_host_change: hostChange,
        confirm_removal: removal,
      });
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "settings.node_domain_cloudflare") {
        const ok = await confirm({
          title: tr("节点通信域名解析到了 Cloudflare", "The node domain resolves to Cloudflare"),
          description: errText(e),
          tone: "warning",
          confirmLabel: tr("仍然保存", "Save anyway"),
        });
        return ok ? putDomains(true, hostChange, removal) : false;
      }
      if (code === "settings.host_gate") {
        const ok = await confirm({
          title: tr("当前地址将被拒绝", "This address will be refused"),
          description: errText(e),
          tone: "warning",
          confirmLabel: tr("确认保存", "Save"),
        });
        return ok ? putDomains(force, true, removal) : false;
      }
      toast({ tone: "error", title: errText(e) });
      return false;
    }
    return true;
  };

  useSavePart({
    count: f.edited.length,
    errors: 0,
    discard: f.reset,
    save: async () => {
      let removal = false;
      if (f.isEdited("main") || f.isEdited("sub") || f.isEdited("node") || f.isEdited("perUser")) {
        let impact: Impact;
        try {
          impact = await post<Impact>("/settings/domains/impact", {
            main_domains: v.main,
            sub_domains: v.sub,
            node_domains: v.node,
            sub_domain_per_user: v.perUser,
          });
        } catch (e) {
          toast({ tone: "error", title: errText(e) });
          return false;
        }
        if (impact.removed.length) {
          const names = impact.removed.map((r) => r.domain).join("、");
          const ok = await confirm({
            title: tr(`删除域名 ${names}？`, `Remove ${names}?`),
            impact: tr("以下地方会受影响", "These places are affected"),
            details: (
              <ul className="grid gap-2 text-body">
                {impact.removed.map((r) => (
                  <li key={`${r.kind}:${r.domain}`}>
                    <span className="font-mono font-medium">{r.domain}</span>{" "}
                    <Badge>{kindName(r.kind as Kind, tr)}</Badge>
                    <ul className="mt-1 ml-4 list-disc text-muted-foreground">
                      {r.places.map((p) => (
                        <li key={p.what}>{placeText(p, tr)}</li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            ),
            typeToConfirm: impact.removed[0].domain,
            confirmLabel: tr("删除并保存", "Remove and save"),
          });
          if (!ok) return false;
          removal = true;
        }
      }
      if (!(await putDomains(false, false, removal))) return false;
      await settled();
      toast({ tone: "success", title: tr("域名设置已保存", "Domains saved") });
      f.reset();
      return true;
    },
  });

  const dns = async (kind: Kind, domain: string) => {
    const key = `${kind}:${domain}`;
    setChecks((c) => ({ ...c, [key]: { tone: "neutral", text: tr("检测中…", "Checking…") } }));
    try {
      const r = await post<{ level: string; message: string }>("/settings/dns-check", { kind, domain });
      setChecks((c) => ({
        ...c,
        [key]: {
          tone: r.level === "ok" ? "success" : "warning",
          text: `${r.level === "ok" ? tr("解析正常", "Resolves") : tr("注意", "Check")}：${r.message}`,
        },
      }));
    } catch (e) {
      setChecks((c) => ({ ...c, [key]: { tone: "warning", text: errText(e) } }));
    }
  };

  /** What a domain serves (shown on wide screens, like "影响 门户、邮件链接"). */
  const impactOf = (kind: Kind, dom: string, preferred: boolean): string | undefined => {
    if (kind === "main")
      return preferred
        ? tr("门户、后台、邮件与安装链接", "Portal, console, mail and install links")
        : tr("门户与后台", "Portal and console");
    if (kind === "sub")
      return preferred || v.perUser
        ? tr("订阅链接", "Subscription links")
        : tr("备用，不出现在链接里", "Spare, not in links");
    const n = d.server_names.find((x) => x.name === dom || x.display === dom || x.name.split(":")[0] === dom)?.nodes
      .length;
    return n ? tr(`${n} 台服务器`, `${n} servers`) : undefined;
  };

  const list = (kind: Kind, footer: string, extra?: ReactNode) => {
    const items = v[kind];
    return (
      <Group title={kindName(kind, tr)} footer={footer}>
        {items.map((dom, i) => {
          const c = checks[`${kind}:${dom}`];
          const isNew = !d[kind].domains.some((x) => x.domain === dom);
          const locked = i === 0 && items.length > 1;
          const impact = impactOf(kind, dom, i === 0);
          return (
            <div key={dom} className="px-4 py-2.5" data-domain={dom}>
              <div className="flex items-center gap-x-3 gap-y-1">
                <GripVertical className="size-4 shrink-0 text-faint max-sm:hidden" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate font-mono text-body" title={dom}>
                  {dom}
                </span>
                {isNew && <Badge tone="info">{tr("未保存", "Unsaved")}</Badge>}
                {i === 0 ? (
                  <Badge tone="primary">
                    <Star className="fill-current" aria-hidden="true" />
                    {tr("首选", "Preferred")}
                  </Badge>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-muted-foreground"
                    aria-label={tr(`设为首选 ${dom}`, `Make ${dom} preferred`)}
                    onClick={() => f.set(kind, [dom, ...items.filter((_, j) => j !== i)])}
                  >
                    {tr("设为首选", "Make preferred")}
                  </Button>
                )}
                {c && c.tone !== "neutral" && (
                  <Badge tone={c.tone} className="max-md:hidden">
                    {c.tone === "success" ? <CircleCheck aria-hidden="true" /> : <TriangleAlert aria-hidden="true" />}
                    {c.tone === "success" ? tr("DNS 正常", "DNS ok") : tr("DNS 需检查", "Check DNS")}
                  </Badge>
                )}
                {impact && (
                  <span className="shrink-0 text-footnote text-muted-foreground max-md:hidden">
                    {tr(`影响 ${impact}`, `Serves ${impact}`)}
                  </span>
                )}
                <RowMenu label={tr(`更多操作 ${dom}`, `More for ${dom}`)}>
                  {() => (
                    <>
                      {i > 0 && (
                        <MenuItem icon={Star} onClick={() => f.set(kind, [dom, ...items.filter((_, j) => j !== i)])}>
                          {tr("设为首选", "Make preferred")}
                        </MenuItem>
                      )}
                      <MenuItem icon={Radar} onClick={() => void dns(kind, dom)}>
                        {tr("DNS 检测", "Check DNS")}
                      </MenuItem>
                      <MenuSeparator />
                      <MenuItem
                        icon={Trash2}
                        danger
                        disabled={locked}
                        onClick={() =>
                          f.set(
                            kind,
                            items.filter((_, j) => j !== i),
                          )
                        }
                      >
                        {locked ? tr("首选域名不能移除", "The preferred one stays") : tr("移除", "Remove")}
                      </MenuItem>
                    </>
                  )}
                </RowMenu>
              </div>
              {c && (
                <p role="status" className="mt-1 text-footnote text-muted-foreground sm:pl-7">
                  {c.text}
                </p>
              )}
            </div>
          );
        })}
        <AddRow kind={kind} taken={[...v.main, ...v.sub, ...v.node]} onAdd={(dom) => f.set(kind, [...items, dom])} />
        {extra}
      </Group>
    );
  };

  return (
    <>
      <Warnings items={d.warnings} />
      {list(
        "main",
        tr(
          "门户、后台、安装链接与支付回调使用的域名。首选域名用于邮件链接与安装命令。",
          "Serves the portal, console, install links and payment notices. The preferred one is used in mail links and install commands.",
        ),
      )}
      {list(
        "sub",
        tr(
          "订阅链接只在这些域名上可用（没有时使用主域名）。",
          "Subscription links work on these only (the main domain when empty).",
        ),
        <SwitchRow
          label={tr("每个用户随机分配订阅域名", "Random subscription domain per user")}
          description={tr(
            "从上面的列表里为每个用户固定挑一个（默认关）",
            "Pin one of the list to each user (off by default)",
          )}
          checked={v.perUser}
          onChange={(x) => f.set("perUser", x)}
        />,
      )}
      {list(
        "node",
        tr(
          "agent 通过它连接面板。必须是「仅 DNS」（Cloudflare 灰色云朵），证书域名只增不减。",
          "Agents dial the panel through it. It must be DNS only (never proxied); certificate names only grow.",
        ),
      )}
      <CloudflareGroup d={d} trust={v.trust} setTrust={(x) => f.set("trust", x)} />
      <ServerNames d={d} />
      <PasskeyCentre d={d} />
    </>
  );
}

/** The last row of a domain list: type a name, 添加 (Enter works too); a bad name is explained below. */
function AddRow({ kind, taken, onAdd }: { kind: Kind; taken: string[]; onAdd: (d: string) => void }) {
  const tr = useTr();
  const [value, setValue] = useState("");
  const [shown, setShown] = useState(false);
  const id = useId();
  const dom = value.trim().toLowerCase();
  const error =
    domainError(dom, tr) ?? (taken.includes(dom) ? tr("这个域名已经在列表里了", "Already listed") : undefined);
  const visible = shown && dom ? error : undefined;
  const add = () => {
    setShown(true);
    if (!error) {
      onAdd(dom);
      setValue("");
      setShown(false);
    }
  };
  return (
    <div className="px-4 py-2.5">
      <div className="flex items-center gap-2">
        <Input
          aria-label={tr(`新的${kindOne(kind, tr)}`, `New ${kindOne(kind, tr)}`)}
          aria-invalid={visible ? true : undefined}
          aria-describedby={visible ? `${id}-e` : undefined}
          className="font-mono"
          placeholder={kind === "sub" ? "sub.example.com" : kind === "node" ? "edge.example.com" : "portal.example.com"}
          autoCapitalize="off"
          spellCheck={false}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => setShown(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <Button
          variant="soft"
          icon={Plus}
          disabled={!dom || (shown && !!error)}
          aria-label={tr(`添加${kindOne(kind, tr)}`, `Add a ${kindOne(kind, tr)}`)}
          onClick={add}
        >
          {tr("添加", "Add")}
        </Button>
      </div>
      {visible && (
        <p id={`${id}-e`} className="mt-1 text-footnote text-destructive">
          {visible}
        </p>
      )}
    </div>
  );
}

function CloudflareGroup({ d, trust, setTrust }: { d: SettingsView; trust: string; setTrust: (v: string) => void }) {
  const tr = useTr();
  const qc = useQueryClient();
  const [run] = useAction();
  const [editing, setEditing] = useState(false);
  const f = useDraft({ ranges: (d.security.cloudflare_ranges ?? []).join("\n") });
  const ranges = lines(f.value!.ranges);
  useSavePart({
    count: f.edited.length,
    errors: 0,
    discard: f.reset,
    save: async () => {
      const cur = fresh(qc, ["settings"], d);
      const r = await run(
        () =>
          put("/settings/security", {
            version: cur.version,
            audit_retention_days: cur.security.audit_retention_days.value,
            traffic_daily_retention_days: cur.security.traffic_daily_retention_days.value,
            cloudflare_ranges: ranges.length ? ranges : null,
            extra_release_keys: cur.security.extra_release_keys,
          }),
        { ok: tr("Cloudflare 网段已保存", "Cloudflare ranges saved") },
      );
      if (r === undefined) return false;
      f.reset();
      return true;
    },
  });
  return (
    <Group
      title="Cloudflare"
      footer={tr(
        "只在请求来自 Cloudflare 网段、且整条转发链都受信时才读取 CF-Connecting-IP。",
        "CF-Connecting-IP is read only when the request comes from a Cloudflare range through trusted hops.",
      )}
    >
      <FieldRow
        label={tr("信任 Cloudflare（读取 CF-Connecting-IP）", "Trust Cloudflare (CF-Connecting-IP)")}
        description={tr(
          "用 Cloudflare 代理门户时打开，登录限速与审计才能看到真实地址",
          "Turn on when Cloudflare proxies the portal, so rate limits and the audit see real addresses",
        )}
      >
        {(a) => (
          <Select {...a} className="sm:w-44" value={trust} onChange={(e) => setTrust(e.target.value)}>
            <option value="">
              {tr(
                `默认（${d.trust_cloudflare.effective ? "开" : "关"}）`,
                `Default (${d.trust_cloudflare.effective ? "on" : "off"})`,
              )}
            </option>
            <option value="true">{tr("开启", "On")}</option>
            <option value="false">{tr("关闭", "Off")}</option>
          </Select>
        )}
      </FieldRow>
      <InfoRow
        label={tr("Cloudflare 网段", "Cloudflare ranges")}
        description={
          ranges.length
            ? tr(
                `自定义 ${ranges.length} 段：${ranges.slice(0, 2).join("、")}${ranges.length > 2 ? " 等" : ""}`,
                `${ranges.length} custom: ${ranges.slice(0, 2).join(", ")}${ranges.length > 2 ? "…" : ""}`,
              )
            : tr(
                `使用内置的 ${d.security.cloudflare_ranges_shipped} 段`,
                `The ${d.security.cloudflare_ranges_shipped} shipped ranges`,
              )
        }
      >
        {f.isEdited("ranges") && <Badge tone="info">{tr("未保存", "Unsaved")}</Badge>}
        <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
          {tr("编辑网段", "Edit ranges")}
        </Button>
      </InfoRow>
      {editing && (
        <RangesDialog
          value={f.value!.ranges}
          shipped={d.security.cloudflare_ranges_shipped}
          onClose={() => setEditing(false)}
          onDone={(t) => {
            f.set("ranges", lines(t).join("\n"));
            setEditing(false);
          }}
        />
      )}
    </Group>
  );
}

function RangesDialog({
  value,
  shipped,
  onClose,
  onDone,
}: {
  value: string;
  shipped: number;
  onClose: () => void;
  onDone: (t: string) => void;
}) {
  const tr = useTr();
  const [t, setT] = useState(value);
  return (
    <Dialog
      open
      onClose={onClose}
      title={tr("Cloudflare 网段", "Cloudflare ranges")}
      description={tr(
        `每行一个网段；留空 = 使用内置的 ${shipped} 段。完成后在保存栏保存。`,
        `One range per line; empty = the ${shipped} shipped ones. Save in the save bar afterwards.`,
      )}
      onSubmit={() => onDone(t)}
      footer={
        <>
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button type="submit" variant="primary">
            {tr("完成", "Done")}
          </Button>
        </>
      }
    >
      <Field label={tr("网段（每行一个）", "Ranges (one per line)")}>
        <Textarea data-autofocus rows={10} className="font-mono" value={t} onChange={(e) => setT(e.target.value)} />
      </Field>
    </Dialog>
  );
}

function ServerNames({ d }: { d: SettingsView }) {
  const tr = useTr();
  const confirm = useConfirm();
  if (!d.server_names.length) return null;
  return (
    <Group
      title={tr("节点通信证书域名", "gRPC certificate names")}
      footer={tr(
        "面板 gRPC 证书包含的名字：只增不减，不再使用的可以移除（立即生效）。",
        "Names in the panel's gRPC certificate: they only grow; unused ones can be removed (applies at once).",
      )}
    >
      {d.server_names.map((n) => (
        <InfoRow
          key={n.name}
          label={<span className="font-mono">{n.display}</span>}
          description={
            <>
              {tr(
                `${n.source === "config" ? "来自旧配置" : "已使用"} · 首次使用 ${dateTime(n.first_used_at)}`,
                `${n.source === "config" ? "From the old config" : "Used"} · first used ${dateTime(n.first_used_at)}`,
              )}
              {n.nodes.length > 0 && tr(` · ${n.nodes.length} 台服务器在用`, ` · used by ${n.nodes.length} servers`)}
            </>
          }
        >
          {n.current && <Badge tone="success">{tr("当前", "Current")}</Badge>}
          {n.locked ? (
            <span className="text-footnote text-muted-foreground">{tr("不能移除", "Cannot be removed")}</span>
          ) : (
            <Button
              size="sm"
              variant="destructive-soft"
              aria-label={tr(`移除证书域名 ${n.display}`, `Remove ${n.display}`)}
              onClick={() =>
                void confirm({
                  title: tr(`移除证书域名 ${n.display}？`, `Remove ${n.display}?`),
                  impact: n.nodes.length
                    ? tr(`${n.nodes.length} 台服务器仍在使用它`, `${n.nodes.length} servers still use it`)
                    : undefined,
                  details: n.nodes.length ? (
                    <ul className="list-disc pl-5 text-body">
                      {n.nodes.map((x) => (
                        <li key={x.id}>{x.name}</li>
                      ))}
                    </ul>
                  ) : undefined,
                  confirmLabel: tr("移除", "Remove"),
                  action: () => post("/settings/server-names/remove", { name: n.name, confirm: true }),
                })
              }
            >
              {tr("移除", "Remove")}
            </Button>
          )}
        </InfoRow>
      ))}
    </Group>
  );
}

type Passkeys = { passkeys: { current: boolean }[] };

/** SET-27: the passkey centre (WebAuthn RP ID); changing it voids every bound passkey. */
function PasskeyCentre({ d }: { d: SettingsView }) {
  const tr = useTr();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [run] = useAction();
  const [editing, setEditing] = useState(false);
  const mine = useQuery({ queryKey: ["me", "passkeys"], queryFn: () => get<Passkeys>("/me/passkeys") });
  const f = useDraft({ domain: d.passkey.domain ?? "" });
  const next = f.value!.domain;
  useSavePart({
    count: f.edited.length,
    errors: 0,
    discard: f.reset,
    save: async () => {
      if (d.passkey.domain !== null) {
        const own = mine.data?.passkeys.filter((p) => p.current).length;
        const ok = await confirm({
          title: next
            ? tr(`把通行密钥中心域名改为 ${next}？`, `Change the passkey centre to ${next}?`)
            : tr("清除通行密钥中心域名？", "Clear the passkey centre?"),
          impact: tr(
            "所有账户（含管理员）已绑定的通行密钥立即全部失效",
            "Every passkey bound by any account (admins included) stops working at once",
          ),
          impacts: [
            { label: tr("失效范围", "Affected"), value: tr("全部账户的通行密钥", "All accounts' passkeys") },
            ...(own !== undefined ? [{ label: tr("你自己的通行密钥", "Your own passkeys"), value: own }] : []),
          ],
          description: tr(
            "用户之后用密码登录并重新绑定；「只用通行密钥登录」的账户只能由管理员在服务器上执行 akari admin reset-login <邮箱> 恢复。",
            "Users then sign in with a password and bind again; passkey-only accounts are recovered on the server with akari admin reset-login <email>.",
          ),
          typeToConfirm: next || tr("清除", "clear"),
          confirmLabel: tr("更换并使通行密钥失效", "Change and void passkeys"),
        });
        if (!ok) return false;
      }
      const cur = fresh(qc, ["settings"], d);
      const r = await run(() => put("/settings/passkey-domain", { version: cur.version, domain: next || null }), {
        ok: tr("通行密钥中心域名已保存", "Passkey centre saved"),
      });
      if (r === undefined) return false;
      f.reset();
      return true;
    },
  });
  return (
    <>
      <Group
        title={tr("通行密钥中心域名", "Passkey centre")}
        footer={tr(
          "通行密钥绑定在这个域名上，所有主域名通过它共用同一套通行密钥。它必须是单独的域名，只提供 /.well-known/webauthn。留空 = 以首选主域名为准（多个主域名时只有首选的能用通行密钥）。",
          "Passkeys are bound to this domain; every main domain shares one set through it. It must be a domain of its own, serving only /.well-known/webauthn. Empty = the preferred main domain (with several main domains only that one can use passkeys).",
        )}
      >
        <InfoRow label={tr("中心域名", "Centre domain")}>
          <span className="font-mono text-body">{d.passkey.domain ?? tr("未设置", "Not set")}</span>
        </InfoRow>
        {d.passkey.domain && (
          <>
            <InfoRow label="RP ID">
              <Mono>{d.passkey.rp_id ?? "—"}</Mono>
            </InfoRow>
            <InfoRow
              label={tr("关联来源", "Related origins")}
              description={tr(
                `涉及 ${d.passkey.labels} 个不同的注册域（浏览器上限 ${d.passkey.label_limit}）`,
                `${d.passkey.labels} distinct registrable domains (browsers allow ${d.passkey.label_limit})`,
              )}
            >
              <span className="font-mono text-footnote break-all">{d.passkey.related_origins.join(", ") || "—"}</span>
            </InfoRow>
          </>
        )}
      </Group>
      <DangerZone>
        <InfoRow
          label={tr("更换通行密钥中心域名", "Change the passkey centre")}
          description={
            f.isEdited("domain")
              ? tr(`将改为 ${next || "（清除）"}，保存时确认。`, `Becomes ${next || "(cleared)"}; confirmed on save.`)
              : tr(
                  "更换后所有账户（含管理员）已绑定的通行密钥全部失效，需要重新绑定。不要轮换。",
                  "Changing it voids every bound passkey (admins included); everyone binds again. Do not rotate it.",
                )
          }
        >
          {f.isEdited("domain") && <Badge tone="info">{tr("未保存", "Unsaved")}</Badge>}
          <Button size="sm" variant="destructive-soft" onClick={() => setEditing(true)}>
            {d.passkey.domain ? tr("更换…", "Change…") : tr("设置…", "Set…")}
          </Button>
        </InfoRow>
      </DangerZone>
      {editing && (
        <CentreDialog
          value={next}
          onClose={() => setEditing(false)}
          onDone={(x) => {
            f.set("domain", x);
            setEditing(false);
          }}
        />
      )}
    </>
  );
}

function CentreDialog({ value, onClose, onDone }: { value: string; onClose: () => void; onDone: (v: string) => void }) {
  const tr = useTr();
  const [t, setT] = useState(value);
  const dom = t.trim().toLowerCase();
  const error = dom ? domainError(dom, tr) : undefined;
  return (
    <Dialog
      open
      size="sm"
      tone="danger"
      onClose={onClose}
      title={tr("通行密钥中心域名", "Passkey centre")}
      description={tr("留空 = 清除。保存时还要再确认一次。", "Empty = clear. Confirmed again on save.")}
      onSubmit={() => !error && onDone(dom)}
      footer={
        <>
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button type="submit" variant="primary" disabled={!!error}>
            {tr("完成", "Done")}
          </Button>
        </>
      }
    >
      <Field label={tr("新的中心域名", "New centre domain")} error={error}>
        <Input
          data-autofocus
          className="font-mono"
          placeholder="passkey.example.com"
          autoCapitalize="off"
          spellCheck={false}
          value={t}
          onChange={(e) => setT(e.target.value)}
        />
      </Field>
    </Dialog>
  );
}
