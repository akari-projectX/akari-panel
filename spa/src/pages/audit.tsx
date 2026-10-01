import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";

import { ErrorText, TableNote } from "../components/status";
import { useT } from "../i18n";
import { get, type AuditEntry, type AuditPage } from "../lib/api";
import { errorText } from "../lib/errors";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";

const PAGE = 50;

function query(before: number | null, actor: string, action: string): string {
  const p = new URLSearchParams({ limit: String(PAGE) });
  if (before != null) p.set("before", String(before));
  if (actor) p.set("actor", actor);
  if (action) p.set("action", action);
  return `/audit?${p.toString()}`;
}

function change(e: AuditEntry): string {
  const parts: string[] = [];
  if (e.before != null) parts.push(`之前 ${JSON.stringify(e.before)}`);
  if (e.after != null) parts.push(`之后 ${JSON.stringify(e.after)}`);
  return parts.join(" · ");
}

// Admin audit log (Chinese only): newest first, keyset pagination.
export function AdminAudit() {
  const t = useT();
  const [actor, setActor] = useState("");
  const [action, setAction] = useState("");
  const [filter, setFilter] = useState({ actor: "", action: "" });
  const pages = useInfiniteQuery({
    queryKey: ["audit", filter],
    queryFn: ({ pageParam }) => get<AuditPage>(query(pageParam, filter.actor, filter.action)),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.next_before,
  });
  const entries = (pages.data?.pages ?? []).flatMap((p) => p.entries);

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h1>审计日志</h1>
        </CardTitle>
        <CardDescription>所有管理操作、登录与密钥轮换。秘密内容从不记录，只记录“已更改”。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          aria-label="筛选审计日志"
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            setFilter({ actor: actor.trim(), action: action.trim() });
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="audit-actor">操作者</Label>
            <Input
              id="audit-actor"
              placeholder="账号，或 cli / system"
              value={actor}
              onChange={(e) => setActor(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="audit-action">操作</Label>
            <Input
              id="audit-action"
              placeholder="如 user.update，或前缀 user."
              value={action}
              onChange={(e) => setAction(e.target.value)}
            />
          </div>
          <Button type="submit" variant="outline">
            筛选
          </Button>
        </form>
        {pages.isError && <ErrorText>{errorText(pages.error, t)}</ErrorText>}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>时间</TableHead>
              <TableHead>操作者</TableHead>
              <TableHead>地址</TableHead>
              <TableHead>操作</TableHead>
              <TableHead>对象</TableHead>
              <TableHead>变更</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pages.isPending && <TableNote colSpan={6}>加载中…</TableNote>}
            {pages.isSuccess && entries.length === 0 && <TableNote colSpan={6}>没有符合条件的记录。</TableNote>}
            {entries.map((e) => (
              <TableRow key={e.id}>
                <TableCell className="whitespace-nowrap text-muted-foreground">
                  {new Date(e.at).toLocaleString("zh-CN")}
                </TableCell>
                <TableCell className="font-medium">{e.actor_login}</TableCell>
                <TableCell className="text-muted-foreground">{e.ip ?? "—"}</TableCell>
                <TableCell>{e.action}</TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {e.target_type ? `${e.target_type} ${e.target_id ?? ""}` : "—"}
                </TableCell>
                <TableCell className="max-w-md break-all font-mono text-xs">{change(e)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {pages.hasNextPage && (
          <Button variant="outline" size="sm" onClick={() => pages.fetchNextPage()} disabled={pages.isFetchingNextPage}>
            加载更早的记录
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
