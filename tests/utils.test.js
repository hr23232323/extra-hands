import { describe, it, expect } from "vitest";
import { boxPath, applyEdit } from "../frontend/utils.js";

// ── boxPath ────────────────────────────────────────────────────────────────────

describe("boxPath", () => {
  const ws = "/workspace";

  it("handles a simple relative path", () => {
    expect(boxPath(ws, "file.txt")).toBe("/workspace/file.txt");
  });

  it("handles a subdirectory path", () => {
    expect(boxPath(ws, "subdir/file.txt")).toBe("/workspace/subdir/file.txt");
  });

  it("neutralizes path traversal with ..", () => {
    expect(boxPath(ws, "../../etc/passwd")).toBe("/workspace/etc/passwd");
  });

  it("strips workspace prefix if already included", () => {
    expect(boxPath(ws, "/workspace/file.txt")).toBe("/workspace/file.txt");
  });

  it("handles leading slash on relative path", () => {
    expect(boxPath(ws, "/subdir/file.txt")).toBe("/workspace/subdir/file.txt");
  });

  it("handles dot segments", () => {
    expect(boxPath(ws, "./subdir/./file.txt")).toBe("/workspace/subdir/file.txt");
  });

  it("returns raw normPath when no workspace", () => {
    expect(boxPath("", "subdir/file.txt")).toBe("subdir/file.txt");
  });
});

// ── applyEdit ─────────────────────────────────────────────────────────────────

describe("applyEdit — Strategy 1: exact match", () => {
  it("replaces exact text", () => {
    const { result } = applyEdit("hello world", "world", "earth");
    expect(result).toBe("hello earth");
  });

  it("replaces multiline exact match", () => {
    const content = "line1\nline2\nline3";
    const { result } = applyEdit(content, "line1\nline2", "replaced");
    expect(result).toBe("replaced\nline3");
  });

  it("normalizes CRLF before matching", () => {
    const { result } = applyEdit("hello\r\nworld", "hello\nworld", "replaced");
    expect(result).toBe("replaced");
  });

  it("errors when old_string appears multiple times (ambiguous)", () => {
    const { error } = applyEdit("foo foo foo", "foo", "bar");
    expect(error).toMatch(/Found 3 matches/);
  });

  it("replaceAll replaces every occurrence", () => {
    const { result } = applyEdit("foo foo foo", "foo", "bar", true);
    expect(result).toBe("bar bar bar");
  });

  it("errors when old_string not found with replaceAll", () => {
    const { error } = applyEdit("hello world", "missing", "x", true);
    expect(error).toMatch(/not found/);
  });
});

describe("applyEdit — Strategy 2: line-trimmed match", () => {
  it("matches when lines have extra leading spaces", () => {
    const content = "function foo() {\n    return 1;\n}";
    const old = "function foo() {\n  return 1;\n}";
    const { result } = applyEdit(content, old, "function foo() {\n    return 2;\n}");
    expect(result).toContain("return 2");
  });

  it("errors when trimmed match is ambiguous", () => {
    const content = "  foo\n  bar\n  foo\n  bar";
    const { error } = applyEdit(content, "foo\nbar", "x");
    expect(error).toMatch(/Found 2 matches/);
  });
});

describe("applyEdit — Strategy 3: indentation-flexible match", () => {
  it("matches when overall indentation differs", () => {
    const content = "    if (x) {\n        return y;\n    }";
    const old = "if (x) {\n    return y;\n}";
    const { result } = applyEdit(content, old, "if (x) {\n    return z;\n}");
    expect(result).toContain("return z");
  });
});

describe("applyEdit — not found", () => {
  it("returns a descriptive error when nothing matches", () => {
    const { error } = applyEdit("hello world", "xyz", "abc");
    expect(error).toMatch(/not found/);
    expect(error).toMatch(/read_file/);
  });
});
