// Ops 后台：系统设置 → 站点 → 品牌：Logo / 网站图标（仅 PNG，服务端校验
// 签名、尺寸与大小，存数据库，在秘密前缀下带缓存头提供）、页脚文字与链接、
// 服务条款 / 隐私政策链接、门户订阅卡片里的各平台客户端下载链接。
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Textarea } from "../components/ui/textarea";
import {
  brandUrl,
  del,
  get,
  PLATFORMS,
  put,
  putBinary,
  type Branding,
  type ClientDownload,
  type FooterLink,
  type Platform,
} from "../lib/api";
import { adminErrorText } from "../lib/admin-errors";

const errText = (err: unknown) => (err instanceof Error ? adminErrorText(err) : "失败");

export const PLATFORM_ZH: Record<Platform, string> = {
  windows: "Windows",
  macos: "macOS",
  linux: "Linux",
  android: "Android",
  ios: "iOS",
  harmony: "鸿蒙",
  other: "其他",
};

export function BrandingSettings() {
  const branding = useQuery({ queryKey: ["branding"], queryFn: () => get<Branding>("/settings/branding") });
  // Lives here: a save bumps the version, which remounts the form.
  const [saved, setSaved] = useState(false);
  if (branding.isPending) return <p className="text-sm text-muted-foreground">加载中…</p>;
  if (branding.isError)
    return (
      <p role="alert" className="text-sm text-destructive">
        {errText(branding.error)}
      </p>
    );
  return (
    <div className="space-y-6">
      <ImagesCard data={branding.data} />
      <BrandingForm key={branding.data.version} data={branding.data} saved={saved} setSaved={setSaved} />
    </div>
  );
}

function useRefresh() {
  const qc = useQueryClient();
  return (b?: Branding) => {
    if (b) qc.setQueryData(["branding"], b);
    void qc.invalidateQueries({ queryKey: ["branding"] });
    void qc.invalidateQueries({ queryKey: ["auth-options"] });
  };
}

function ImagesCard({ data }: { data: Branding }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Logo 与网站图标</h2>
        </CardTitle>
        <CardDescription>
          仅支持 PNG（不支持 SVG）。Logo 最大 256 KiB、2048×2048；网站图标最大 64 KiB、256×256，建议 64×64。
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6 sm:grid-cols-2">
        <ImageField which="logo" label="Logo" url={data.logo_url} />
        <ImageField which="favicon" label="网站图标" url={data.favicon_url} />
      </CardContent>
    </Card>
  );
}

function ImageField({ which, label, url }: { which: "logo" | "favicon"; label: string; url: string | null }) {
  const refresh = useRefresh();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = `brand-${which}`;

  async function upload(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      refresh(await putBinary<Branding>(`/settings/branding/${which}`, file));
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    setBusy(true);
    setError(null);
    try {
      refresh(await del<Branding>(`/settings/branding/${which}`));
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>上传{label}</Label>
      <div className="flex h-20 items-center justify-center rounded-lg border border-dashed border-border bg-muted/40">
        {url ? (
          <img src={brandUrl(url)} alt={`当前${label}`} className="max-h-16 max-w-full" />
        ) : (
          <span className="text-xs text-muted-foreground">未设置</span>
        )}
      </div>
      <Input
        id={id}
        type="file"
        accept="image/png"
        disabled={busy}
        onChange={(e) => {
          void upload(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      {url && (
        <Button size="sm" variant="ghost" className="text-destructive" disabled={busy} onClick={() => void remove()}>
          移除{label}
        </Button>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** The PUT body of the form (empty optional fields = null; blank rows dropped). */
export function brandingBody(
  version: number,
  f: { footer_text: string; tos_url: string; privacy_url: string; links: FooterLink[]; downloads: ClientDownload[] },
) {
  return {
    version,
    footer_text: f.footer_text.trim() || null,
    footer_links: f.links.filter((l) => l.label.trim() || l.url.trim()),
    tos_url: f.tos_url.trim() || null,
    privacy_url: f.privacy_url.trim() || null,
    client_downloads: f.downloads
      .filter((d) => d.url.trim())
      .map((d) => ({ ...d, label: d.label?.trim() ? d.label.trim() : null })),
  };
}

function BrandingForm({ data, saved, setSaved }: { data: Branding; saved: boolean; setSaved: (v: boolean) => void }) {
  const refresh = useRefresh();
  const [footer, setFooter] = useState(data.footer_text ?? "");
  const [tos, setTos] = useState(data.tos_url ?? "");
  const [privacy, setPrivacy] = useState(data.privacy_url ?? "");
  const [links, setLinks] = useState<FooterLink[]>(data.footer_links);
  const [downloads, setDownloads] = useState<ClientDownload[]>(data.client_downloads);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const b = await put<Branding>(
        "/settings/branding",
        brandingBody(data.version, { footer_text: footer, tos_url: tos, privacy_url: privacy, links, downloads }),
      );
      setSaved(true);
      refresh(b);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>页脚与链接</h2>
        </CardTitle>
        <CardDescription>
          显示在用户门户与登录页底部；客户端下载链接显示在门户的订阅链接卡片里。链接须以 https://、http:// 或 / 开头。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-5" onSubmit={save} noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="brand-footer">页脚文字</Label>
            <Textarea
              id="brand-footer"
              rows={2}
              maxLength={500}
              value={footer}
              onChange={(e) => setFooter(e.target.value)}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="brand-tos">服务条款链接</Label>
              <Input id="brand-tos" value={tos} placeholder="https://…" onChange={(e) => setTos(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="brand-privacy">隐私政策链接</Label>
              <Input
                id="brand-privacy"
                value={privacy}
                placeholder="https://…"
                onChange={(e) => setPrivacy(e.target.value)}
              />
            </div>
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">页脚链接（最多 8 个）</legend>
            {links.map((l, i) => (
              <div key={i} className="flex flex-wrap gap-2">
                <Input
                  aria-label={`页脚链接 ${i + 1} 文字`}
                  className="w-40"
                  value={l.label}
                  onChange={(e) => setLinks(links.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                />
                <Input
                  aria-label={`页脚链接 ${i + 1} 地址`}
                  className="min-w-0 flex-1"
                  value={l.url}
                  onChange={(e) => setLinks(links.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))}
                />
                <Button type="button" variant="ghost" onClick={() => setLinks(links.filter((_, j) => j !== i))}>
                  删除
                </Button>
              </div>
            ))}
            {links.length < 8 && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setLinks([...links, { label: "", url: "" }])}
              >
                添加页脚链接
              </Button>
            )}
          </fieldset>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">客户端下载（最多 12 个）</legend>
            {downloads.map((d, i) => (
              <div key={i} className="flex flex-wrap gap-2">
                <select
                  aria-label={`下载 ${i + 1} 平台`}
                  className="h-10 rounded-lg border border-border bg-card px-3 text-sm"
                  value={d.platform}
                  onChange={(e) =>
                    setDownloads(
                      downloads.map((x, j) => (j === i ? { ...x, platform: e.target.value as Platform } : x)),
                    )
                  }
                >
                  {PLATFORMS.map((p) => (
                    <option key={p} value={p}>
                      {PLATFORM_ZH[p]}
                    </option>
                  ))}
                </select>
                <Input
                  aria-label={`下载 ${i + 1} 名称`}
                  className="w-40"
                  placeholder="客户端名称（可选）"
                  value={d.label ?? ""}
                  onChange={(e) =>
                    setDownloads(downloads.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))
                  }
                />
                <Input
                  aria-label={`下载 ${i + 1} 地址`}
                  className="min-w-0 flex-1"
                  placeholder="https://…"
                  value={d.url}
                  onChange={(e) => setDownloads(downloads.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))}
                />
                <Button type="button" variant="ghost" onClick={() => setDownloads(downloads.filter((_, j) => j !== i))}>
                  删除
                </Button>
              </div>
            ))}
            {downloads.length < 12 && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setDownloads([...downloads, { platform: "windows", label: null, url: "" }])}
              >
                添加下载链接
              </Button>
            )}
          </fieldset>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {saved && (
            <p role="status" className="text-sm text-emerald-700">
              已保存。
            </p>
          )}
          <Button type="submit" disabled={busy}>
            保存页脚与链接
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
