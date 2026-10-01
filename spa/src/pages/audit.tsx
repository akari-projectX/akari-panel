import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";

import { get, type AuditEntry, type AuditPage } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";

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
  if (e.before != null) parts.push(`before ${JSON.stringify(e.before)}`);
  if (e.after != null) parts.push(`after ${JSON.stringify(e.after)}`);
  return parts.join(" · ");
}

// Admin audit log: newest first, keyset pagination ("Load older").
export function AdminAudit() {
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
        <CardTitle>Audit log</CardTitle>
        <CardDescription>
          Every administrative change, login and secret rotation. Secrets are never recorded, only
          that they changed.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            setFilter({ actor: actor.trim(), action: action.trim() });
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="audit-actor">Actor</Label>
            <Input id="audit-actor" placeholder="login or cli" value={actor} onChange={(e) => setActor(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="audit-action">Action</Label>
            <Input
              id="audit-action"
              placeholder="user.update or user."
              value={action}
              onChange={(e) => setAction(e.target.value)}
            />
          </div>
          <Button type="submit" variant="outline">
            Filter
          </Button>
        </form>
        {pages.isError && <p className="text-sm text-destructive">{pages.error.message}</p>}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>Actor</TableHead>
              <TableHead>Address</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Target</TableHead>
              <TableHead>Change</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map((e) => (
              <TableRow key={e.id}>
                <TableCell className="whitespace-nowrap text-muted-foreground">
                  {new Date(e.at).toLocaleString()}
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
            Load older
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
