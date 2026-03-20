// ── utils.js — pure utility functions (no DOM, no side effects) ────────────────

export function normPath(p) {
  return p.replace(/\\/g, "/");
}

/**
 * Box any path into the workspace root, neutralizing path traversal.
 * e.g. boxPath("/ws", "../../etc/passwd") → "/ws/etc/passwd"
 */
export function boxPath(workspace, rawPath) {
  if (!workspace) return normPath(rawPath);
  let rel = normPath(rawPath);
  if (rel.startsWith(workspace + "/")) rel = rel.slice(workspace.length + 1);
  else if (rel.startsWith("/"))        rel = rel.slice(1);
  const parts = [];
  for (const seg of rel.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg && seg !== ".") parts.push(seg);
  }
  return `${workspace}/${parts.join("/")}`;
}

/**
 * Apply a targeted edit to file content using a 3-strategy fuzzy fallback chain.
 * Returns { result: string } on success or { error: string } on failure.
 *
 * Strategy 1: Exact match (after CRLF normalization)
 * Strategy 2: Line-trimmed match (ignores leading/trailing whitespace per line)
 * Strategy 3: Indentation-flexible match (strips minimum common indentation)
 */
export function applyEdit(fileContent, oldString, newString, replaceAll = false) {
  const norm = s => s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const content = norm(fileContent);
  const search  = norm(oldString);

  // ── Strategy 1: Exact ───────────────────────────────────────────────────────
  const exactCount = search ? content.split(search).length - 1 : 0;
  if (exactCount > 1 && !replaceAll) {
    return { error: `Found ${exactCount} matches for old_string. Add more surrounding context lines to make it unique, or set replace_all=true to replace all occurrences.` };
  }
  if (exactCount >= 1) {
    return { result: replaceAll ? content.split(search).join(newString) : content.replace(search, newString) };
  }
  if (replaceAll) {
    return { error: "old_string not found in file. Re-read with read_file and copy old_string exactly." };
  }

  const searchLines  = search.split("\n");
  const contentLines = content.split("\n");

  // ── Strategy 2: Line-trimmed ────────────────────────────────────────────────
  const trimMatches = [];
  for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
    if (searchLines.every((sl, j) => contentLines[i + j].trim() === sl.trim())) {
      trimMatches.push(i);
    }
  }
  if (trimMatches.length > 1) {
    return { error: `Found ${trimMatches.length} matches via whitespace-flexible matching. Add more surrounding context lines to old_string.` };
  }
  if (trimMatches.length === 1) {
    const lines = [...contentLines];
    lines.splice(trimMatches[0], searchLines.length, ...newString.split("\n"));
    return { result: lines.join("\n") };
  }

  // ── Strategy 3: Indentation-flexible ────────────────────────────────────────
  const stripMinIndent = s => {
    const lines = s.split("\n");
    const nonEmpty = lines.filter(l => l.trim().length > 0);
    if (!nonEmpty.length) return s;
    const min = Math.min(...nonEmpty.map(l => l.match(/^( *)/)[1].length));
    return lines.map(l => l.slice(min)).join("\n");
  };
  const normSearch = stripMinIndent(search);
  const indentMatches = [];
  for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
    const block = contentLines.slice(i, i + searchLines.length).join("\n");
    if (stripMinIndent(block) === normSearch) indentMatches.push(i);
  }
  if (indentMatches.length > 1) {
    return { error: `Found ${indentMatches.length} matches via indentation-flexible matching. Add more surrounding context lines to old_string.` };
  }
  if (indentMatches.length === 1) {
    const lines = [...contentLines];
    lines.splice(indentMatches[0], searchLines.length, ...newString.split("\n"));
    return { result: lines.join("\n") };
  }

  return { error: "old_string not found in file (tried exact, whitespace-trimmed, and indentation-flexible matching). Re-read the file with read_file and copy old_string exactly as it appears, including indentation and blank lines." };
}
