import type { QueryClient } from "@tanstack/react-query";

// After a successful logout: drop every cached query except "me", then
// reset "me" so its active observer refetches, gets 401 and the app falls
// back to <Login />. queryClient.clear() is NOT enough: it removes queries
// without notifying observers, leaving the dashboard on screen.
export async function resetAfterLogout(queryClient: QueryClient): Promise<void> {
  queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== "me" });
  await queryClient.resetQueries({ queryKey: ["me"] });
}
