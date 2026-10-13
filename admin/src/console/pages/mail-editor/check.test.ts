import { describe, expect, it } from "vitest";
import { checkDraft, closest, placeholdersIn } from "./check";

describe("placeholdersIn", () => {
  it("finds names with line and column, like the panel's scanner", () => {
    expect(placeholdersIn("a {x}\n  {y_1} {Bad} {{z}}").map((p) => [p.name, p.line, p.column])).toEqual([
      ["x", 1, 3],
      ["y_1", 2, 3],
      ["z", 2, 16],
    ]);
    expect(placeholdersIn("{open")).toEqual([]);
  });
});

describe("checkDraft", () => {
  const allowed = ["site", "code", "minutes"];
  it("reports unknown placeholders once, with their place", () => {
    const p = checkDraft({ subject: "{site}", body: "{code}\n{nope} {nope}", html: "", source: false }, allowed, [
      "code",
    ]);
    expect(p).toEqual([{ field: "body", kind: "unknown", name: "nope", line: 2, column: 1 }]);
  });
  it("wants required placeholders in the text and, in source mode, in the HTML", () => {
    const p = checkDraft({ subject: "Hi", body: "no code", html: "<p>{minutes}</p>", source: true }, allowed, ["code"]);
    expect(p.map((x) => [x.field, x.kind, x.name])).toEqual([
      ["body", "missing", "code"],
      ["html_source", "missing", "code"],
    ]);
  });
  it("reports empty parts", () => {
    const p = checkDraft({ subject: " ", body: "{code}", html: "", source: true }, allowed, ["code"]);
    expect(p.map((x) => [x.field, x.kind])).toEqual([
      ["subject", "empty"],
      ["html_source", "empty"],
    ]);
  });
});

describe("closest", () => {
  it("suggests the allowed name an unknown one most likely meant", () => {
    expect(closest("order_number", ["site", "order_no", "plan_name"])).toBe("order_no");
    expect(closest("cdoe", ["site", "code", "minutes"])).toBe("code");
    expect(closest("zzzzzz", ["site", "code"])).toBeUndefined();
  });
});
