// Ops 后台：系统设置 → 邮件模板。每种邮件 × 中/英一份模板（主题 + 正文），
// 只能用该种邮件的占位符（服务端校验：未知占位符拒绝、必需占位符不能删）；
// 实时预览 = 服务端用示例数据渲染（HTML 在无脚本的沙箱 iframe 里显示）；
// 「恢复默认」删除自定义版本；「发送测试邮件」用已保存的版本与示例数据。
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import { useAdminConfirm as useConfirm } from "../admin-confirm";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Textarea } from "../components/ui/textarea";
import { del, get, post, put } from "../lib/api";
import { adminErrorText } from "../lib/admin-errors";

const errText = (err: unknown) => (err instanceof Error ? adminErrorText(err) : "失败");

export interface MailTemplate {
  kind: string;
  label: string;
  locale: "zh" | "en";
  subject: string;
  body: string;
  default_subject: string;
  default_body: string;
  custom: boolean;
  version: number;
  placeholders: { name: string; description: string }[];
  required: string[];
}

interface Rendered {
  subject: string;
  text: string;
  html: string;
}

/** `{name}` tokens of a template text that are not in `allowed` (the server's rule). */
export function unknownPlaceholders(text: string, allowed: string[]): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\{([a-z0-9_]+)\}/g)) {
    if (!allowed.includes(m[1]) && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

export function MailTemplates() {
  const list = useQuery({
    queryKey: ["mail-templates"],
    queryFn: () => get<MailTemplate[]>("/settings/mail-templates"),
  });
  const [kind, setKind] = useState("register_code");
  const [locale, setLocale] = useState<"zh" | "en">("zh");
  const kinds = useMemo(() => {
    const seen = new Map<string, { label: string; custom: boolean }>();
    for (const t of list.data ?? []) {
      const s = seen.get(t.kind);
      seen.set(t.kind, { label: t.label, custom: (s?.custom ?? false) || t.custom });
    }
    return [...seen.entries()];
  }, [list.data]);
  const current = list.data?.find((t) => t.kind === kind && t.locale === locale);
  if (list.isPending) return <p className="text-sm text-muted-foreground">加载中…</p>;
  if (list.isError)
    return (
      <p role="alert" className="text-sm text-destructive">
        {errText(list.error)}
      </p>
    );
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>邮件模板</h2>
        </CardTitle>
        <CardDescription>
          修改各类邮件的主题与正文（中文、英文各一份，按收件人语言发送）。正文中空行分段；单独成段的链接占位符显示为按钮。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="tpl-kind">邮件种类</Label>
            <select
              id="tpl-kind"
              className="h-10 rounded-lg border border-border bg-card px-3 text-sm"
              value={kind}
              onChange={(e) => setKind(e.target.value)}
            >
              {kinds.map(([k, v]) => (
                <option key={k} value={k}>
                  {v.label}
                  {v.custom ? "（已自定义）" : ""}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tpl-locale">语言</Label>
            <select
              id="tpl-locale"
              className="h-10 rounded-lg border border-border bg-card px-3 text-sm"
              value={locale}
              onChange={(e) => setLocale(e.target.value as "zh" | "en")}
            >
              <option value="zh">中文</option>
              <option value="en">英文</option>
            </select>
          </div>
        </div>
        {current && <TemplateEditor key={`${current.kind}/${current.locale}/${current.version}`} t={current} />}
      </CardContent>
    </Card>
  );
}

function TemplateEditor({ t }: { t: MailTemplate }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [subject, setSubject] = useState(t.subject);
  const [body, setBody] = useState(t.body);
  const [preview, setPreview] = useState<Rendered | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [to, setTo] = useState("");
  const allowed = t.placeholders.map((p) => p.name);
  const unknown = unknownPlaceholders(`${subject}\n${body}`, allowed);
  const missing = t.required.filter((r) => !`${subject}\n${body}`.includes(`{${r}}`));

  useEffect(() => {
    let live = true;
    const h = setTimeout(() => {
      post<Rendered>("/settings/mail-templates/preview", { kind: t.kind, locale: t.locale, subject, body })
        .then((r) => {
          if (!live) return;
          setPreview(r);
          setPreviewError(null);
        })
        .catch((e: unknown) => live && setPreviewError(errText(e)));
    }, 400);
    return () => {
      live = false;
      clearTimeout(h);
    };
  }, [t.kind, t.locale, subject, body]);

  const path = `/settings/mail-templates/${t.kind}/${t.locale}`;
  async function run(f: () => Promise<unknown>, ok: string) {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await f();
      setNote(ok);
      await qc.invalidateQueries({ queryKey: ["mail-templates"] });
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-6 xl:grid-cols-2">
      <form
        className="space-y-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => put(path, { version: t.version, subject, body }), "已保存模板。");
        }}
      >
        <div className="flex items-center gap-2 text-sm">
          {t.custom ? <Badge>已自定义</Badge> : <Badge variant="secondary">默认模板</Badge>}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="tpl-subject">邮件主题</Label>
          <Input id="tpl-subject" maxLength={200} value={subject} onChange={(e) => setSubject(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="tpl-body">邮件正文</Label>
          <Textarea id="tpl-body" rows={14} value={body} onChange={(e) => setBody(e.target.value)} />
        </div>
        <section aria-label="可用占位符" className="space-y-1">
          <p className="text-sm font-medium">可用占位符（点击插入正文）</p>
          <ul className="flex flex-wrap gap-2">
            {t.placeholders.map((p) => (
              <li key={p.name}>
                <button
                  type="button"
                  title={p.description}
                  className="rounded border border-border px-2 py-1 font-mono text-xs hover:bg-muted"
                  onClick={() => setBody((b) => `${b}{${p.name}}`)}
                >
                  {`{${p.name}}`}
                  {t.required.includes(p.name) && <span className="text-destructive">*</span>}
                </button>
                <span className="ml-1 text-xs text-muted-foreground">{p.description}</span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">* 为必需占位符。</p>
        </section>
        {unknown.length > 0 && (
          <p role="alert" className="text-sm text-destructive">
            未知占位符：{unknown.map((u) => `{${u}}`).join("、")}
          </p>
        )}
        {missing.length > 0 && (
          <p role="alert" className="text-sm text-destructive">
            缺少必需占位符：{missing.map((u) => `{${u}}`).join("、")}
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {note && (
          <p role="status" className="text-sm text-emerald-700">
            {note}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy || unknown.length > 0 || missing.length > 0}>
            保存模板
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy || !t.custom}
            onClick={() =>
              void confirm({
                title: "恢复默认模板？",
                body: "自定义的主题与正文会被删除，之后发送内置的默认版本。",
                destructive: true,
                confirmLabel: "恢复默认",
              }).then((yes) => {
                if (yes) void run(() => del(path), "已恢复默认。");
              })
            }
          >
            恢复默认
          </Button>
        </div>
        <div className="flex flex-wrap items-end gap-2 border-t border-border pt-4">
          <div className="min-w-0 flex-1 space-y-1.5">
            <Label htmlFor="tpl-test-to">测试收件地址（发送已保存的版本，使用示例数据）</Label>
            <Input id="tpl-test-to" type="email" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={busy || !to.trim()}
            onClick={() => void run(() => post(`${path}/test`, { to }), `测试邮件已发出：${to}`)}
          >
            发送模板测试邮件
          </Button>
        </div>
      </form>
      <section aria-label="模板预览" className="space-y-2">
        <p className="text-sm font-medium">预览（示例数据）</p>
        {previewError && (
          <p role="alert" className="text-sm text-destructive">
            {previewError}
          </p>
        )}
        {preview && (
          <>
            <p className="text-sm">
              <span className="text-muted-foreground">主题：</span>
              <span data-testid="tpl-preview-subject">{preview.subject}</span>
            </p>
            {/* sandbox without allow-scripts: the preview can never run code. */}
            <iframe
              title="邮件 HTML 预览"
              sandbox=""
              srcDoc={preview.html}
              className="h-96 w-full rounded-lg border border-border bg-white"
            />
            <details>
              <summary className="cursor-pointer text-sm">纯文本版本</summary>
              <pre className="mt-2 whitespace-pre-wrap rounded-lg bg-muted p-3 text-xs">{preview.text}</pre>
            </details>
          </>
        )}
      </section>
    </div>
  );
}
