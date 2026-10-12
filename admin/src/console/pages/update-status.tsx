// The agent update status (GET /agent-updates) and the "new version" badge
// the dashboard and the node list show (DSH-06). Kept out of the updates
// page so those pages do not pull its chunk in.
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { get } from "../../shared/api";
import { useTr } from "../../shared/i18n";
import { Badge } from "../../shared/ui/badge";

export type UpdateStatus = {
  version: number;
  source_url: string | null;
  default_source_url: string;
  auto_check: boolean;
  next_auto_check_at: string | null;
  checking: boolean;
  keys_configured: boolean;
  last_check: {
    at: string;
    ok: boolean;
    result: string;
    version: string | null;
    code: string | null;
    params: Record<string, unknown> | null;
    message: string | null;
    stored: string[];
  } | null;
  latest: { version: string; platforms: string[] } | null;
  outdated_servers: number;
  update_available: string | null;
};

export function useUpdateStatus(poll = false) {
  return useQuery({
    queryKey: ["agent-updates"],
    queryFn: () => get<UpdateStatus>("/agent-updates"),
    refetchInterval: (q) => (poll || q.state.data?.checking ? 2000 : 60_000),
  });
}

/** "有新版本 vX" when servers run an older agent than the newest stored release. */
export function UpdateBadge() {
  const tr = useTr();
  const s = useUpdateStatus();
  if (!s.data?.update_available) return null;
  return (
    <Link
      to="/updates"
      className="rounded-full focus-visible:ring-[3px] focus-visible:ring-ring focus-visible:outline-none"
    >
      <Badge tone="info">{tr(`有新版本 ${s.data.update_available}`, `New version ${s.data.update_available}`)}</Badge>
    </Link>
  );
}
