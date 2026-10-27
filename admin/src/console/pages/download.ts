// CSV downloads through the API client's rules (audit §5.5/§5.6: no bare
// <a download>): fetch the file, and on a refusal throw the coded ApiError
// so the page shows the mapped message instead of the browser opening the
// JSON body. A successful body is saved through a Blob URL (CSP-safe).
import { ApiError } from "../../shared/api";
import { apiBase } from "../../shared/base";

/** The file name of a `Content-Disposition` header, if any. */
function dispositionName(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""));
    } catch {
      /* fall through to the plain name */
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header);
  return plain ? plain[1].trim() : null;
}

/** GET `path` (below /api/v1) and save the body as a file. */
export async function downloadFile(path: string, fallbackName: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${apiBase}${path}`, { credentials: "same-origin" });
  } catch {
    throw new ApiError(0, "network error", { code: "" });
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string } & Record<string, unknown>;
    throw new ApiError(res.status, body.error ?? res.statusText, body);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = dispositionName(res.headers.get("content-disposition")) ?? fallbackName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
