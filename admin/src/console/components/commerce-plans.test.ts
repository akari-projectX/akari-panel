import { describe, expect, it } from "vitest";
import { firstLine } from "./commerce-plans";

describe("firstLine", () => {
  it("is the first non-empty line as plain text (the description is Markdown)", () => {
    expect(firstLine("\n- **核心配置**：80 GB\n- 300 Mbps")).toBe("核心配置：80 GB");
    expect(firstLine("Fast __lines__ and `code`\n\nmore")).toBe("Fast lines and code");
    expect(firstLine("1. one\n2. two")).toBe("one");
    expect(firstLine("## Heading")).toBe("Heading");
    expect(firstLine("> quoted")).toBe("quoted");
    expect(firstLine("-5% off")).toBe("-5% off");
    expect(firstLine("  \n ")).toBe("");
  });
});
