import { describe, expect, it } from "vitest";
import { DEFAULT_NEXT_PATH, safeNextPath } from "@/lib/safe-next-path";

describe("safeNextPath — open-redirect guard on /login?next=", () => {
  it("accepts a same-origin absolute path, keeping query and hash", () => {
    expect(safeNextPath("/calendar")).toBe("/calendar");
    expect(safeNextPath("/inbox/new?for=2026-09-28")).toBe("/inbox/new?for=2026-09-28");
    expect(safeNextPath("/today#top")).toBe("/today#top");
    expect(safeNextPath("/")).toBe("/");
  });

  it("falls back to /today when the value is missing or empty", () => {
    expect(safeNextPath(null)).toBe(DEFAULT_NEXT_PATH);
    expect(safeNextPath(undefined)).toBe(DEFAULT_NEXT_PATH);
    expect(safeNextPath("")).toBe(DEFAULT_NEXT_PATH);
    expect(safeNextPath("/x", "/calendar")).toBe("/x");
    expect(safeNextPath(null, "/calendar")).toBe("/calendar");
  });

  it("rejects absolute and protocol-relative URLs", () => {
    expect(safeNextPath("https://evil.example/login")).toBe(DEFAULT_NEXT_PATH);
    expect(safeNextPath("http://evil.example")).toBe(DEFAULT_NEXT_PATH);
    expect(safeNextPath("//evil.example")).toBe(DEFAULT_NEXT_PATH);
    expect(safeNextPath("///evil.example")).toBe(DEFAULT_NEXT_PATH);
    expect(safeNextPath("javascript:alert(1)")).toBe(DEFAULT_NEXT_PATH);
    expect(safeNextPath("today")).toBe(DEFAULT_NEXT_PATH);
  });

  it("rejects the backslash and control-character forms that URL parsers normalise into //host", () => {
    expect(safeNextPath("/\\evil.example")).toBe(DEFAULT_NEXT_PATH);
    expect(safeNextPath("/\t/evil.example")).toBe(DEFAULT_NEXT_PATH);
    expect(safeNextPath("/\n/evil.example")).toBe(DEFAULT_NEXT_PATH);
    expect(safeNextPath("/ /evil.example")).toBe(DEFAULT_NEXT_PATH);
    expect(safeNextPath("/today\\@evil.example")).toBe(DEFAULT_NEXT_PATH);
  });

  it("normalises dot segments within the same origin", () => {
    expect(safeNextPath("/a/../calendar")).toBe("/calendar");
    expect(safeNextPath("/a/./b")).toBe("/a/b");
  });

  it("never bounces back onto the login form", () => {
    expect(safeNextPath("/login")).toBe(DEFAULT_NEXT_PATH);
    expect(safeNextPath("/login?next=/calendar")).toBe(DEFAULT_NEXT_PATH);
  });

  it("rejects absurdly long values", () => {
    expect(safeNextPath("/" + "a".repeat(5000))).toBe(DEFAULT_NEXT_PATH);
  });
});
