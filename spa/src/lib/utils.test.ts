import { describe, expect, it } from "vitest";

import { humanBytes } from "./utils";

describe("humanBytes", () => {
  it("uses binary units labelled as such", () => {
    expect(humanBytes(0)).toBe("0 B");
    expect(humanBytes(1023)).toBe("1023 B");
    expect(humanBytes(1024)).toBe("1.0 KiB");
    expect(humanBytes(1.5 * 1024 ** 2)).toBe("1.5 MiB");
    expect(humanBytes(100 * 1024 ** 3)).toBe("100.0 GiB");
    expect(humanBytes(2 * 1024 ** 4)).toBe("2.0 TiB");
    expect(humanBytes(Number.NaN)).toBe("-");
  });
});
