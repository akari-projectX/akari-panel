// 内容 · 公告标签 (CNT-07, CNT-08). The small coloured label in front of an
// announcement's title. A tag = Chinese name, optional English name and one
// of eleven preset colours (no free colour: every tag reads well in both
// themes); tags are ordered, can be disabled, and a tag that announcements
// use can only be disabled, not deleted. The list is a card with the
// tag as the portal shows it, its colour, the number of announcements using
// it, ↑ ↓ to reorder and a ⋯ menu (edit, disable / enable, delete); the editor
// is a md dialog with the colour swatches and a live preview. URL:
// `/content/tags`, `?open=new|<id>`.
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Eye, EyeOff, Pencil, Plus, Tag, Trash2 } from "lucide-react";
import { useState } from "react";
import { del, get, post, put } from "../../shared/api";
import { cn } from "../../shared/cn";
import { useTr, type Tr } from "../../shared/i18n";
import { Badge } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { Card } from "../../shared/ui/card";
import { useConfirm } from "../../shared/ui/confirm";
import { Dialog } from "../../shared/ui/dialog";
import { Field, Input, Switch } from "../../shared/ui/form";
import { MenuItem, MenuSeparator, RowMenu } from "../../shared/ui/menu";
import { EmptyState, ErrorState, Skeleton } from "../../shared/ui/states";
import { useToast } from "../../shared/ui/toast";
import { SaveFooter } from "../components/kit";
import { useAction } from "../data";
import { useQS } from "../router";

export type AnnouncementTag = {
  id: string;
  name_zh: string;
  name_en: string | null;
  color: string;
  enabled: boolean;
  sort: number;
  /** Announcements carrying the tag. */
  uses: number;
  created_at: string;
};

/** The preset colour keys, in the palette's order (the server accepts exactly these). */
const TAG_COLORS = [
  "red",
  "orange",
  "amber",
  "green",
  "teal",
  "cyan",
  "blue",
  "indigo",
  "violet",
  "pink",
  "slate",
] as const;

function colorName(c: string, tr: Tr) {
  return (
    (
      {
        red: tr("红", "Red"),
        orange: tr("橙", "Orange"),
        amber: tr("琥珀", "Amber"),
        green: tr("绿", "Green"),
        teal: tr("青绿", "Teal"),
        cyan: tr("青", "Cyan"),
        blue: tr("蓝", "Blue"),
        indigo: tr("靛", "Indigo"),
        violet: tr("紫", "Violet"),
        pink: tr("玫红", "Pink"),
        slate: tr("灰", "Slate"),
      } as Record<string, string>
    )[c] ?? c
  );
}

export function useAnnouncementTags() {
  return useQuery({ queryKey: ["announcement-tags"], queryFn: () => get<AnnouncementTag[]>("/announcement-tags") });
}

/** The tag as users see it (solid, small). */
export function TagChip({ name, color, className }: { name: string; color: string; className?: string }) {
  return (
    <span className={cn("ann-tag", className)} data-tag={color} data-testid="ann-tag">
      {name}
    </span>
  );
}

const MAX_NAME = 12;

export function TagsManager() {
  const tr = useTr();
  const q = useAnnouncementTags();
  const [query, patch] = useQS();
  const [reorder] = useAction();
  const [toggle] = useAction();
  const remove = useDeleteTag();
  const list = q.data ?? [];
  const open = query.get("open");
  const editing = open && open !== "new" ? list.find((t) => t.id === open) : undefined;

  const move = (i: number, d: -1 | 1) => {
    const ids = list.map((t) => t.id);
    [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
    void reorder(() => put("/announcement-tags/order", { ids }));
  };
  const flip = (t: AnnouncementTag) =>
    void toggle(
      () =>
        put(`/announcement-tags/${t.id}`, {
          name_zh: t.name_zh,
          name_en: t.name_en,
          color: t.color,
          enabled: !t.enabled,
        }),
      { ok: t.enabled ? tr("已停用", "Disabled") : tr("已启用", "Enabled") },
    );

  let body;
  if (q.isPending)
    body = (
      <Card className="divide-y divide-separator" aria-busy="true">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="flex h-14 items-center gap-4 px-4">
            <Skeleton className="h-5 w-16" />
            <Skeleton className="ml-auto h-3 w-1/4" />
          </div>
        ))}
      </Card>
    );
  else if (q.isError && !q.data)
    body = (
      <Card>
        <ErrorState
          title={tr("公告标签加载失败", "The tags did not load")}
          error={q.error}
          onRetry={() => void q.refetch()}
        />
      </Card>
    );
  else if (list.length === 0)
    body = (
      <Card>
        <EmptyState
          icon={Tag}
          title={tr("还没有标签", "No tags yet")}
          description={tr(
            "标签显示在公告标题前，例如「维护」「活动」。",
            "A tag shows before an announcement's title, e.g. Maintenance or Event.",
          )}
          action={
            <Button variant="primary" icon={Plus} onClick={() => patch({ open: "new" })}>
              {tr("新建标签", "New tag")}
            </Button>
          }
        />
      </Card>
    );
  else
    body = (
      <Card className="divide-y divide-separator overflow-hidden" data-testid="tag-list">
        {list.map((t, i) => (
          <div
            key={t.id}
            data-testid="tag-row"
            className={cn(
              "flex min-h-14 items-center gap-3 px-4 py-2 hover:bg-accent/50 sm:gap-4",
              !t.enabled && "opacity-70",
            )}
          >
            <span className="flex shrink-0">
              <Button
                variant="ghost"
                size="icon-sm"
                icon={ArrowUp}
                disabled={i === 0}
                aria-label={tr(`上移 ${t.name_zh}`, `Move ${t.name_zh} up`)}
                onClick={() => move(i, -1)}
              />
              <Button
                variant="ghost"
                size="icon-sm"
                icon={ArrowDown}
                disabled={i === list.length - 1}
                aria-label={tr(`下移 ${t.name_zh}`, `Move ${t.name_zh} down`)}
                onClick={() => move(i, 1)}
              />
            </span>
            <button
              type="button"
              onClick={() => patch({ open: t.id })}
              className="flex min-w-0 flex-1 items-center gap-3 text-left"
              aria-label={tr(`编辑 ${t.name_zh}`, `Edit ${t.name_zh}`)}
            >
              <TagChip name={t.name_zh} color={t.color} />
              <span className="min-w-0 truncate text-footnote text-muted-foreground">
                {t.name_en ?? <span className="text-faint">{tr("未填英文名", "No English name")}</span>}
              </span>
            </button>
            <span className="flex shrink-0 items-center gap-2 text-footnote text-muted-foreground">
              <span className="ann-tag-dot size-2.5 rounded-full max-sm:hidden" data-tag={t.color} aria-hidden="true" />
              <span className="max-sm:hidden">{colorName(t.color, tr)}</span>
            </span>
            <span className="tnum w-20 shrink-0 text-right text-footnote text-muted-foreground">
              {tr(`${t.uses} 条公告`, `${t.uses} in use`)}
            </span>
            {!t.enabled && <Badge tone="neutral">{tr("已停用", "Disabled")}</Badge>}
            <RowMenu label={tr(`${t.name_zh} 的操作`, `Actions of ${t.name_zh}`)}>
              {() => (
                <>
                  <MenuItem icon={Pencil} onClick={() => patch({ open: t.id })}>
                    {tr("编辑", "Edit")}
                  </MenuItem>
                  <MenuItem icon={t.enabled ? EyeOff : Eye} onClick={() => flip(t)}>
                    {t.enabled ? tr("停用", "Disable") : tr("启用", "Enable")}
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem icon={Trash2} danger disabled={t.uses > 0} onClick={() => void remove(t)}>
                    {t.uses > 0
                      ? tr("删除（使用中，只能停用）", "Delete (in use: disable instead)")
                      : tr("删除…", "Delete…")}
                  </MenuItem>
                </>
              )}
            </RowMenu>
          </div>
        ))}
      </Card>
    );

  return (
    <>
      <p className="mb-3 px-1 text-footnote text-muted-foreground">
        {tr(
          "标签显示在公告标题前。正在被公告使用的标签只能停用：停用后旧公告照常显示它，新公告不能再选。",
          "A tag shows before an announcement's title. A tag in use can only be disabled: old announcements keep showing it, new ones cannot pick it.",
        )}
      </p>
      {body}
      {open && (open === "new" || editing) && (
        <TagEditor key={open} tag={editing ?? null} onClose={() => patch({ open: null }, true)} />
      )}
    </>
  );
}

function useDeleteTag() {
  const tr = useTr();
  const confirm = useConfirm();
  const toast = useToast();
  return async (t: AnnouncementTag): Promise<boolean> => {
    const ok = await confirm({
      title: tr(`删除标签「${t.name_zh}」？`, `Delete the tag "${t.name_zh}"?`),
      description: tr("没有公告在用它。删除后无法恢复。", "No announcement uses it. This cannot be undone."),
      confirmLabel: tr("删除标签", "Delete tag"),
      action: () => del(`/announcement-tags/${t.id}`),
    });
    if (ok) toast({ tone: "success", title: tr("已删除", "Deleted") });
    return ok;
  };
}

function TagEditor({ tag, onClose }: { tag: AnnouncementTag | null; onClose: () => void }) {
  const tr = useTr();
  const [save, saving] = useAction();
  const [f, setF] = useState({
    name_zh: tag?.name_zh ?? "",
    name_en: tag?.name_en ?? "",
    color: tag?.color ?? "pink",
    enabled: tag?.enabled ?? true,
  });
  const [tried, setTried] = useState(false);
  const errs = { name_zh: !f.name_zh.trim() ? tr("请填写中文名称", "Enter the Chinese name") : null };
  const bad = Object.values(errs).filter(Boolean).length;
  const dirty =
    !tag ||
    tag.name_zh !== f.name_zh ||
    (tag.name_en ?? "") !== f.name_en ||
    tag.color !== f.color ||
    tag.enabled !== f.enabled;
  const submit = async () => {
    setTried(true);
    if (bad) return;
    const body = {
      name_zh: f.name_zh.trim(),
      name_en: f.name_en.trim() || null,
      color: f.color,
      enabled: f.enabled,
    };
    const r = await save(() => (tag ? put(`/announcement-tags/${tag.id}`, body) : post("/announcement-tags", body)), {
      ok: tag ? tr("标签已保存", "Tag saved") : tr("标签已创建", "Tag created"),
    });
    if (r !== undefined) onClose();
  };
  return (
    <Dialog
      open
      onClose={onClose}
      size="md"
      icon={Tag}
      title={tag ? tr("编辑标签", "Edit tag") : tr("新建标签", "New tag")}
      description={tr(
        "颜色只能从预设里选，浅色与深色模式下都清楚。",
        "Colours come from a preset palette that reads well in the light and the dark theme.",
      )}
      dirty={dirty && !!tag}
      footer={<SaveFooter tried={tried} bad={bad} saving={saving} onClose={onClose} onSave={() => void submit()} />}
    >
      <div className="grid gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={tr("中文名称", "Chinese name")} required error={tried ? errs.name_zh : undefined}>
            <Input
              value={f.name_zh}
              maxLength={MAX_NAME}
              data-autofocus
              placeholder={tr("例如：维护", "e.g. Maintenance")}
              aria-invalid={(tried && !!errs.name_zh) || undefined}
              onChange={(e) => setF({ ...f, name_zh: e.target.value })}
            />
          </Field>
          <Field
            label={tr("英文名称", "English name")}
            hint={tr("不填则英文用户看到中文", "Empty = English readers see Chinese")}
          >
            <Input
              value={f.name_en}
              maxLength={MAX_NAME}
              placeholder="Maintenance"
              onChange={(e) => setF({ ...f, name_en: e.target.value })}
            />
          </Field>
        </div>
        <Field label={tr("颜色", "Colour")} group>
          <div role="radiogroup" aria-label={tr("颜色", "Colour")} className="flex flex-wrap gap-2.5">
            {TAG_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={f.color === c}
                aria-label={colorName(c, tr)}
                title={colorName(c, tr)}
                data-tag={c}
                onClick={() => setF({ ...f, color: c })}
                className={cn(
                  "ann-tag-dot size-7 rounded-full shadow-[0_0_0_2px_var(--card)] transition-shadow",
                  f.color === c && "shadow-[0_0_0_2px_var(--card),0_0_0_4px_var(--c)]",
                )}
              />
            ))}
          </div>
        </Field>
        <div className="flex items-center gap-3 rounded-lg bg-window px-3 py-2.5 ring-1 ring-border ring-inset">
          <span className="min-w-0 flex-1">
            <span className="block text-body font-medium">{tr("启用", "Enabled")}</span>
            <span className="block text-footnote text-muted-foreground">
              {tr(
                "停用后新公告不能再选它，旧公告照常显示。",
                "When off, new announcements cannot pick it; old ones keep showing it.",
              )}
            </span>
          </span>
          <Switch checked={f.enabled} onChange={(v) => setF({ ...f, enabled: v })} label={tr("启用", "Enabled")} />
        </div>
        <div
          className="rounded-xl bg-window px-4 py-3 ring-1 ring-border ring-inset"
          aria-label={tr("预览", "Preview")}
        >
          <div className="mb-1.5 text-footnote text-muted-foreground">{tr("预览", "Preview")}</div>
          <div className="flex min-w-0 items-center gap-2 text-body font-semibold" data-testid="tag-preview">
            <TagChip name={f.name_zh.trim() || tr("标签", "Tag")} color={f.color} />
            <span className="truncate">
              {tr("双十一全场八折，年付再送 50 GB", "Singles' Day: 20% off, plus 50 GB on yearly plans")}
            </span>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
