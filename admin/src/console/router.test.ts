import { createMemoryRouter } from "react-router";
import { expect, test } from "vitest";
import { setQuery, setRouter } from "./router";

// setQuery keeps the page under the basename (it once doubled it, and the
// catch-all route sent every filter change to the dashboard).
test("setQuery keeps the path under the basename", async () => {
  const r = createMemoryRouter(
    [
      { path: "/users/*", element: null },
      { path: "*", element: null },
    ],
    { basename: "/p/admin", initialEntries: ["/p/admin/users?q=a"] },
  );
  setRouter(r as unknown as Parameters<typeof setRouter>[0]);
  setQuery({ plan: "x" });
  await new Promise((ok) => setTimeout(ok, 0));
  expect(r.state.location.pathname).toBe("/p/admin/users");
  expect(r.state.location.search).toBe("?q=a&plan=x");
});
