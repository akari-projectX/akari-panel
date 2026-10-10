import { describe, expect, it } from "vitest";
import { entryAsEgress } from "./egress";

describe("entryAsEgress", () => {
  it("flags the dial IP listed as an egress", () => {
    expect(entryAsEgress("198.51.100.4", "203.0.113.7\n198.51.100.4")).toBe(true);
    expect(entryAsEgress(" 198.51.100.4 ", "198.51.100.4/32")).toBe(true);
    expect(entryAsEgress("[2001:DB8::1]", "2001:db8::1/128")).toBe(true);
  });
  it("leaves other egresses and host names alone", () => {
    expect(entryAsEgress("198.51.100.4", "203.0.113.7, 198.51.100.0/24")).toBe(false);
    expect(entryAsEgress("relay.example.com", "relay.example.com")).toBe(false);
    expect(entryAsEgress("", "")).toBe(false);
  });
});
