// 系统设置 → 通用 (v2): 站点信息 (SET-01: name, time zone confirmed with the
// day-boundary impact), 外观与品牌 (SET-24: logo / favicon on a light and a
// dark tile, upload and removal apply at once; footer text and links through
// the save bar), 条款与下载链接 (SET-24: terms / privacy, one row per client
// platform with a "在门户显示" switch; every link checked while typing) and
// 域名与证书 (SET-02…05, SET-27 passkey centre, the Cloudflare ranges of
// SET-09). Domain entries are added in a dialog; every change goes through
// the save bar, which lists the impact of removed domains (typed
// confirmation), and confirms a new passkey centre.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Apple,
  ImageUp,
  Monitor,
  Plus,
  Smartphone,
  TabletSmartphone,
  Terminal,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { del, get, put, putBinary } from "../../shared/api";
import { prefixBase } from "../../shared/base";
import { useTr, type Tr } from "../../shared/i18n";
import { Badge } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { Card, Group } from "../../shared/ui/card";
import { useConfirm } from "../../shared/ui/confirm";
import { Input, Select, Switch, Textarea } from "../../shared/ui/form";
import { useAction } from "../data";
import { fresh, type SettingsView, useSettings } from "./settings-data";
import { FieldRow, Loaded, SRow, TimeZonePicker, useDraft, useSavePart, zoneOffset } from "../components/settings-kit";

// ---------------------------------------------------------------------------
// 站点信息
// ---------------------------------------------------------------------------

export function SiteSection() {
  const s = useSettings();
  return (
    <Loaded q={s} rows={3}>
      {(d) => <SiteForm d={d} />}
    </Loaded>
  );
}

/** "2026-10-12 14:20（周一）" in a zone. */
function nowIn(zone: string, tr: Tr): string {
  try {
    const f = new Intl.DateTimeFormat(tr("zh-CN", "en-GB"), {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hour12: false,
    });
    return f.format(new Date());
  } catch {
    return "";
  }
}

/** The next midnight of a zone, shown in that zone ("10-13 00:00"). */
function nextMidnight(zone: string): string {
  try {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" })
        .formatToParts(new Date(Date.now() + 86_400_000))
        .map((x) => [x.type, x.value]),
    );
    return `${p.month}-${p.day} 00:00`;
  } catch {
    return "";
  }
}

function SiteForm({ d }: { d: SettingsView }) {
  const tr = useTr();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [run] = useAction();
  const f = useDraft({ name: d.site_name ?? "", tz: d.timezone.value ?? "" });
  const v = f.value!;
  const nameError = v.name.trim().length > 64 ? tr("最多 64 个字符", "At most 64 characters") : undefined;
  const zone = d.timezone.effective;
  useSavePart({
    count: f.edited.length,
    errors: nameError ? 1 : 0,
    discard: f.reset,
    save: async () => {
      if (f.isEdited("tz")) {
        const next = v.tz || d.timezone.default;
        const ok = await confirm({
          title: tr(`把站点时区改为 ${next}？`, `Change the site time zone to ${next}?`),
          description: tr(
            "之后的日界按新时区计算：流量明细与拦截统计的日、套餐月重置、日历月时长、仪表盘与 CSV 导出的日期都从新时区的 00:00 开始。已有的历史数据不重算。",
            "From now on days are cut in the new time zone: traffic history and block counts, monthly resets, calendar-month terms, the dashboard and CSV dates start at 00:00 there. Existing records are not recomputed.",
          ),
          impacts: [
            {
              label: tr("今天的日界", "Today's day boundary"),
              value: `UTC${zoneOffset(zone)} → UTC${zoneOffset(next)}`,
            },
            {
              label: tr("下一个日界", "Next day boundary"),
              value: tr(`${nextMidnight(next)}（新时区）`, `${nextMidnight(next)} (new zone)`),
            },
            {
              label: tr("当天流量统计", "Today's traffic"),
              value: tr("从下一个日界起按新时区", "In the new zone from the next boundary"),
            },
          ],
          tone: "warning",
          confirmLabel: tr("更改时区", "Change the time zone"),
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
      f.saved();
      return true;
    },
  });
  return (
    <>
      <Group title={tr("站点", "Site")}>
        <FieldRow
          label={tr("站点名称", "Site name")}
          description={tr(
            "出现在门户标题、邮件主题与客户端订阅名里；留空 = Akari",
            "In the portal title, mail subjects and subscription names; empty = Akari",
          )}
          error={nameError}
          changed={f.isEdited("name")}
        >
          {(a) => (
            <Input
              {...a}
              className="sm:w-72"
              placeholder="Akari"
              value={v.name}
              onChange={(e) => f.set("name", e.target.value)}
            />
          )}
        </FieldRow>
      </Group>
      <Group
        title={tr("时区", "Time zone")}
        footer={tr(
          `修改时区会在保存时确认。站点时间：${nowIn(zone, tr)}`,
          `A new time zone is confirmed on save. Site time: ${nowIn(zone, tr)}`,
        )}
      >
        <FieldRow
          label={tr("站点时区", "Site time zone")}
          description={tr(
            "流量按日统计、套餐月重置、仪表盘与导出的日界都按它计算",
            "Cuts the days of traffic history, monthly resets, the dashboard and exports",
          )}
          changed={f.isEdited("tz")}
        >
          {(a) => (
            <TimeZonePicker aria={a} value={v.tz} defaultZone={d.timezone.default} onChange={(z) => f.set("tz", z)} />
          )}
        </FieldRow>
      </Group>
    </>
  );
}

// ---------------------------------------------------------------------------
// 外观与品牌 / 条款与下载链接 (one branding record, two sections)
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
const PLATFORMS: { id: string; zh: string; en: string; icon: LucideIcon }[] = [
  { id: "windows", zh: "Windows", en: "Windows", icon: Monitor },
  { id: "macos", zh: "macOS", en: "macOS", icon: Apple },
  { id: "android", zh: "Android", en: "Android", icon: Smartphone },
  { id: "ios", zh: "iOS", en: "iOS", icon: Smartphone },
  { id: "linux", zh: "Linux", en: "Linux", icon: Terminal },
  { id: "harmony", zh: "鸿蒙", en: "HarmonyOS", icon: TabletSmartphone },
  { id: "other", zh: "其他", en: "Other", icon: Monitor },
];

/** A link of the portal: https, http or a same-site path. */
function linkError(raw: string, tr: Tr, blankOk: boolean): string | undefined {
  const v = raw.trim();
  if (!v) return blankOk ? undefined : tr("请填写链接", "Enter a link");
  if (v.startsWith("/") && !v.startsWith("//")) return undefined;
  try {
    const u = new URL(v);
    if ((u.protocol === "https:" || u.protocol === "http:") && u.host.includes(".")) return undefined;
    if ((u.protocol === "https:" || u.protocol === "http:") && u.hostname === "localhost") return undefined;
  } catch {
    /* below */
  }
  return tr(
    "需要 https:// 开头的完整地址，或以 / 开头的站内路径",
    "Enter a full https:// address or a path starting with /",
  );
}

function useBranding() {
  return useQuery({ queryKey: ["settings", "branding"], queryFn: () => get<Branding>("/settings/branding") });
}

/** The PUT body: the saved record with one section's fields on top. */
function brandingBody(b: Branding, patch: Partial<Branding>) {
  const v = { ...b, ...patch };
  return {
    version: v.version,
    footer_text: v.footer_text?.trim() || null,
    footer_links: v.footer_links.map((l) => ({ label: l.label.trim(), url: l.url.trim() })),
    tos_url: v.tos_url?.trim() || null,
    privacy_url: v.privacy_url?.trim() || null,
    client_downloads: v.client_downloads.map((l) => ({
      platform: l.platform,
      label: l.label?.trim() || null,
      url: l.url.trim(),
    })),
  };
}

export function BrandSection() {
  const q = useBranding();
  return <Loaded q={q}>{(b) => <BrandForm b={b} />}</Loaded>;
}

function BrandForm({ b }: { b: Branding }) {
  const tr = useTr();
  const qc = useQueryClient();
  const [run] = useAction();
  const f = useDraft({ footer_text: b.footer_text ?? "", footer_links: b.footer_links });
  const v = f.value!;
  const linkErrors = v.footer_links.map((l) => ({
    label: l.label.trim() ? undefined : tr("文字不能为空", "Enter a label"),
    url: linkError(l.url, tr, false),
  }));
  const errors = linkErrors.reduce((n, e) => n + (e.label ? 1 : 0) + (e.url ? 1 : 0), 0);
  useSavePart({
    count: f.edited.length,
    errors,
    discard: f.reset,
    save: async () => {
      const cur = fresh(qc, ["settings", "branding"], b);
      const r = await run(() => put("/settings/branding", brandingBody(cur, v)), {
        ok: tr("品牌设置已保存", "Branding saved"),
      });
      if (r === undefined) return false;
      f.saved();
      return true;
    },
  });
  const links = v.footer_links;
  const setLink = (i: number, p: Partial<{ label: string; url: string }>) =>
    f.set(
      "footer_links",
      links.map((x, j) => (j === i ? { ...x, ...p } : x)),
    );
  return (
    <>
      <Group
        title={tr("图片", "Images")}
        footer={tr(
          "上传与删除立即生效，不经过保存栏。仅 PNG：Logo 不超过 2048 像素、256 KB；网站图标不超过 256 像素、64 KB。",
          "Uploads and removals apply at once, not through the save bar. PNG only: the logo up to 2048 px and 256 KB, the favicon up to 256 px and 64 KB.",
        )}
      >
        <ImageRow
          name="logo"
          url={b.logo_url}
          label={tr("Logo", "Logo")}
          hint={tr("门户左上角、登录页与邮件页眉", "The portal's corner, the sign-in page and mail headers")}
        />
        <ImageRow
          name="favicon"
          url={b.favicon_url}
          label={tr("网站图标", "Favicon")}
          hint={tr("浏览器标签页与书签图标", "Browser tabs and bookmarks")}
        />
      </Group>
      <Group title={tr("页脚", "Footer")}>
        <FieldRow
          label={tr("页脚文字", "Footer text")}
          description={tr("门户每页底部；不支持 HTML", "At the bottom of every portal page; no HTML")}
          changed={f.isEdited("footer_text")}
        >
          {(a) => (
            <Textarea
              {...a}
              rows={2}
              className="min-h-14 sm:w-80"
              value={v.footer_text ?? ""}
              onChange={(e) => f.set("footer_text", e.target.value)}
            />
          )}
        </FieldRow>
        <div className="relative px-4 py-3">
          {f.isEdited("footer_links") && (
            <span className="absolute inset-y-2 left-0 w-[3px] rounded-r-full bg-primary" data-changed>
              <span className="sr-only">{tr("已修改", "Edited")}</span>
            </span>
          )}
          <div className="mb-2 flex items-center">
            <div className="flex-1 text-body font-medium">{tr("页脚链接", "Footer links")}</div>
            <Button
              size="sm"
              variant="ghost"
              icon={Plus}
              onClick={() => f.set("footer_links", [...links, { label: "", url: "" }])}
            >
              {tr("添加链接", "Add link")}
            </Button>
          </div>
          {links.length === 0 && (
            <p className="text-footnote text-muted-foreground">{tr("还没有页脚链接。", "No footer links yet.")}</p>
          )}
          <div className="grid gap-2">
            {links.map((l, i) => (
              <div key={i} className="grid gap-1">
                <div className="flex gap-2">
                  <Input
                    aria-label={tr("文字", "Label")}
                    aria-invalid={linkErrors[i].label ? true : undefined}
                    placeholder={tr("文字", "Label")}
                    className="w-36 max-sm:w-28"
                    value={l.label}
                    onChange={(e) => setLink(i, { label: e.target.value })}
                  />
                  <Input
                    aria-label={tr("链接地址", "Link URL")}
                    aria-invalid={linkErrors[i].url ? true : undefined}
                    placeholder={tr("https://… 或 /kb", "https://… or /kb")}
                    className="min-w-0 flex-1 font-mono text-footnote"
                    value={l.url}
                    onChange={(e) => setLink(i, { url: e.target.value })}
                  />
                  <Button
                    size="icon"
                    variant="ghost"
                    icon={X}
                    aria-label={tr(`删除页脚链接 ${i + 1}`, `Remove footer link ${i + 1}`)}
                    onClick={() =>
                      f.set(
                        "footer_links",
                        links.filter((_, j) => j !== i),
                      )
                    }
                  />
                </div>
                {(linkErrors[i].label || linkErrors[i].url) && (
                  <p className="text-footnote text-destructive">{linkErrors[i].label ?? linkErrors[i].url}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      </Group>
    </>
  );
}

function ImageRow({
  name,
  url,
  label,
  hint,
}: {
  name: "logo" | "favicon";
  url: string | null;
  label: string;
  hint: string;
}) {
  const tr = useTr();
  const confirm = useConfirm();
  const [run, busy] = useAction();
  const tile = (dark: boolean) => (
    <span
      className={
        dark
          ? "dark inline-flex size-16 items-center justify-center rounded-xl bg-window ring-1 ring-border ring-inset"
          : "inline-flex size-16 items-center justify-center rounded-xl bg-white ring-1 ring-border ring-inset"
      }
    >
      {url ? (
        <img
          src={`${prefixBase}/${url}`}
          alt={dark ? tr(`${label}（深色底）`, `${label} (dark)`) : label}
          className={name === "logo" ? "max-h-10 max-w-12 object-contain" : "size-6 object-contain"}
        />
      ) : (
        <ImageUp className="size-5 text-faint" aria-hidden="true" />
      )}
    </span>
  );
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3.5">
      <div className="flex gap-2">
        {tile(false)}
        {tile(true)}
      </div>
      <div className="min-w-0 flex-1 max-sm:order-3 max-sm:basis-full">
        <div className="text-body font-medium">{label}</div>
        <div className="mt-0.5 text-footnote text-muted-foreground">{hint}</div>
        <div className="mt-0.5 text-footnote text-faint">
          {url
            ? tr("已上传 · 浅色与深色底预览", "Uploaded · previewed on light and dark")
            : tr("未设置，使用默认图标", "Not set: the default is used")}
        </div>
      </div>
      <div className="flex gap-2 max-sm:ml-auto">
        <Button size="sm" variant="outline" asChild>
          <label className={busy ? "pointer-events-none opacity-50" : "cursor-pointer"}>
            <ImageUp aria-hidden="true" />
            {url ? tr("替换", "Replace") : tr("上传", "Upload")}
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
            variant="ghost"
            icon={Trash2}
            aria-label={tr(`删除${label}`, `Remove the ${label}`)}
            onClick={() =>
              void confirm({
                title: tr(`删除${label}？`, `Remove the ${label}?`),
                description: tr(
                  "立即生效：门户与邮件改回默认样式。",
                  "Applies at once: the portal and mail fall back to the default.",
                ),
                confirmLabel: tr("删除", "Remove"),
                action: () => del(`/settings/branding/${name}`),
              })
            }
          />
        )}
      </div>
    </div>
  );
}

type Dl = { platform: string; label: string | null; url: string; on: boolean };

export function LinksSection() {
  const q = useBranding();
  return <Loaded q={q}>{(b) => <LinksForm b={b} />}</Loaded>;
}

/**
 * One row per platform (its first link; a platform with more links lists
 * them under it). The switch = shown in the portal: a link switched off is
 * kept while editing and dropped when saved (the record has no hidden links).
 */
function LinksForm({ b }: { b: Branding }) {
  const tr = useTr();
  const qc = useQueryClient();
  const [run] = useAction();
  const base: Dl[] = [
    ...b.client_downloads.map((x) => ({ ...x, label: x.label ?? "", on: true })),
    ...PLATFORMS.filter((p) => !b.client_downloads.some((x) => x.platform === p.id) && p.id !== "other").map((p) => ({
      platform: p.id,
      label: "",
      url: "",
      on: false,
    })),
  ];
  const f = useDraft({ tos_url: b.tos_url ?? "", privacy_url: b.privacy_url ?? "", downloads: base });
  const [addP, setAddP] = useState("windows");
  const v = f.value!;
  const tosError = linkError(v.tos_url, tr, true);
  const privacyError = linkError(v.privacy_url, tr, true);
  const dlErrors = v.downloads.map((l) => (l.on ? linkError(l.url, tr, false) : undefined));
  const errors = [tosError, privacyError, ...dlErrors].filter(Boolean).length;
  useSavePart({
    count: f.edited.length,
    errors,
    discard: f.reset,
    save: async () => {
      const cur = fresh(qc, ["settings", "branding"], b);
      const r = await run(
        () =>
          put(
            "/settings/branding",
            brandingBody(cur, {
              tos_url: v.tos_url,
              privacy_url: v.privacy_url,
              client_downloads: v.downloads
                .filter((l) => l.on)
                .map((l) => ({ platform: l.platform, label: l.label, url: l.url })),
            }),
          ),
        { ok: tr("链接已保存", "Links saved") },
      );
      if (r === undefined) return false;
      f.saved();
      return true;
    },
  });
  const dls = v.downloads;
  const setDl = (i: number, p: Partial<Dl>) =>
    f.set(
      "downloads",
      dls.map((x, j) => (j === i ? { ...x, ...p } : x)),
    );
  const order = PLATFORMS.map((p) => p.id);
  const rows = dls
    .map((l, i) => ({ l, i }))
    .sort((a, b2) => order.indexOf(a.l.platform) - order.indexOf(b2.l.platform) || a.i - b2.i);
  return (
    <>
      <Group
        title={tr("法律文本", "Legal")}
        footer={tr(
          "留空 = 门户自带的条款与隐私页。建议放在知识库里，便于修改。",
          "Empty = the portal's own pages. Keeping them in the knowledge base makes them easy to edit.",
        )}
      >
        <FieldRow
          label={tr("服务条款链接", "Terms link")}
          description={tr("注册页「注册即表示同意…」处引用", "Linked from the sign-up page's consent line")}
          error={tosError}
          changed={f.isEdited("tos_url")}
        >
          {(a) => (
            <Input
              {...a}
              className="font-mono text-footnote sm:w-80"
              value={v.tos_url}
              onChange={(e) => f.set("tos_url", e.target.value)}
            />
          )}
        </FieldRow>
        <FieldRow
          label={tr("隐私政策链接", "Privacy link")}
          description={tr("注册页「注册即表示同意…」处引用", "Linked from the sign-up page's consent line")}
          error={privacyError}
          changed={f.isEdited("privacy_url")}
        >
          {(a) => (
            <Input
              {...a}
              className="font-mono text-footnote sm:w-80"
              value={v.privacy_url}
              onChange={(e) => f.set("privacy_url", e.target.value)}
            />
          )}
        </FieldRow>
      </Group>
      <Group
        title={tr("客户端下载", "Client downloads")}
        footer={tr(
          "门户「下载客户端」按用户的系统排序显示。关掉的平台不显示，保存时它的链接一并移除。",
          "The portal's client downloads, sorted for the visitor's system. A platform switched off is not shown; its link is removed on save.",
        )}
      >
        {rows.map(({ l, i }) => {
          const p = PLATFORMS.find((x) => x.id === l.platform) ?? PLATFORMS[PLATFORMS.length - 1];
          const name = tr(p.zh, p.en);
          const first = rows.find((r) => r.l.platform === l.platform)?.i === i;
          return (
            <SRow
              key={i}
              icon={
                <span className="inline-flex size-8 items-center justify-center rounded-[9px] bg-secondary text-muted-foreground">
                  <p.icon className="size-4" aria-hidden="true" />
                </span>
              }
              label={
                <>
                  {first ? name : l.label || name}
                  {!l.on && <Badge tone="outline">{tr("不显示", "Hidden")}</Badge>}
                </>
              }
              changed={JSON.stringify(l) !== JSON.stringify(base[i])}
              error={dlErrors[i]}
              wide
            >
              <Input
                aria-label={tr(`${name} 下载地址`, `${name} download URL`)}
                aria-invalid={dlErrors[i] ? true : undefined}
                disabled={!l.on}
                placeholder="https://…"
                className="w-[340px] font-mono text-footnote max-sm:w-full xl:w-[420px]"
                value={l.url}
                onChange={(e) => setDl(i, { url: e.target.value })}
              />
              <Switch
                label={tr(`在门户显示 ${name}`, `Show ${name} in the portal`)}
                checked={l.on}
                onChange={(on) => setDl(i, { on })}
              />
              {!first && (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  icon={X}
                  aria-label={tr(`删除下载链接 ${name}`, `Remove the ${name} download`)}
                  onClick={() =>
                    f.set(
                      "downloads",
                      dls.filter((_, j) => j !== i),
                    )
                  }
                />
              )}
            </SRow>
          );
        })}
        <div className="flex flex-wrap items-center gap-2 px-4 py-2.5">
          <span className="flex-1 text-footnote text-muted-foreground">
            {tr("同一平台需要多个下载（如不同客户端）时：", "Several downloads for one platform (other clients):")}
          </span>
          <Select
            aria-label={tr("添加下载的平台", "Platform of the new download")}
            className="w-32"
            value={addP}
            onChange={(e) => setAddP(e.target.value)}
          >
            {PLATFORMS.map((p) => (
              <option key={p.id} value={p.id}>
                {tr(p.zh, p.en)}
              </option>
            ))}
          </Select>
          <Button
            size="sm"
            variant="soft"
            icon={Plus}
            onClick={() => {
              const free = dls.findIndex((l) => l.platform === addP && !l.on && !l.url);
              if (free >= 0) setDl(free, { on: true });
              else f.set("downloads", [...dls, { platform: addP, label: "", url: "", on: true }]);
            }}
          >
            {tr("添加下载", "Add download")}
          </Button>
        </div>
      </Group>
      <Card className="flex flex-wrap items-center gap-3 px-4 py-3 text-footnote text-muted-foreground">
        <span className="min-w-0 flex-1 basis-60">
          {tr(
            "订阅里的一键导入按钮（Clash、Stash、Shadowrocket…）在「订阅链接与格式」里开关。",
            "The subscription import buttons (Clash, Stash, Shadowrocket…) are switched in Subscription links and formats.",
          )}
        </span>
        <Button asChild size="sm" variant="ghost">
          <Link to="/settings/subscription">{tr("前往", "Open")}</Link>
        </Button>
      </Card>
    </>
  );
}
