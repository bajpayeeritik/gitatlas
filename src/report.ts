import crypto from "node:crypto";
import type { GraphDB } from "./graph/db.js";
import { compactSymbolList } from "./graph/format.js";
import { languageForFile } from "./indexer/languages.js";
import type { SymbolRow } from "./types.js";

export const REPORT_MARKER = "<!-- gitatlas-blast-radius -->";

/** Report format version, for tests and future comment migrations. */
export function reportFormatVersion(): number {
  return 1;
}

/**
 * Markdown blast-radius report for a set of changed files (a PR, typically).
 * First line is a stable HTML marker so a CI bot can find and update its own
 * comment; last line is a content fingerprint so identical analyses can skip
 * the edit entirely (no notification churn).
 */
export function impactReport(db: GraphDB, changedFiles: string[]): string {
  const changed = [
    ...new Set(
      changedFiles.map((f) => f.replace(/\\/g, "/").trim()).filter(Boolean)
    ),
  ];
  const indexable = changed.filter((f) => languageForFile(f));
  const changedSet = new Set(indexable);

  const rows: { file: string; defined: number; deps: SymbolRow[] }[] = [];
  const uniqueDeps = new Map<number, SymbolRow>();
  for (const f of indexable) {
    const defined = db.fileSymbols(f);
    // dependents inside the PR's own changed set are being reviewed anyway
    const deps =
      defined.length > 0
        ? db
            .callersOf(defined.map((d) => d.id))
            .filter((s) => s.path !== f && !changedSet.has(s.path))
        : [];
    for (const d of deps) uniqueDeps.set(d.id, d);
    rows.push({ file: f, defined: defined.length, deps });
  }
  const depFiles = new Set([...uniqueDeps.values()].map((d) => d.path));

  const body: string[] = [];
  body.push("### ⚡ Blast radius");
  body.push("");
  const unindexed = changed.length - indexable.length;
  body.push(
    `**${indexable.length}** changed source file(s) → ` +
      `**${uniqueDeps.size}** dependent symbol(s) outside this PR, across **${depFiles.size}** file(s)` +
      (unindexed > 0 ? ` · ${unindexed} changed file(s) not indexed` : "")
  );
  body.push("");
  body.push("| Changed file | Symbols defined | Dependents outside PR |");
  body.push("|---|---|---|");
  for (const r of rows) {
    body.push(`| \`${r.file}\` | ${r.defined} | ${r.deps.length} |`);
  }

  const withDeps = rows.filter((r) => r.deps.length > 0);
  if (withDeps.length > 0) {
    body.push("");
    body.push("<details><summary>Dependent code, grouped by file</summary>");
    body.push("");
    for (const r of withDeps) {
      body.push(`**\`${r.file}\`** is depended on by:`);
      body.push("```");
      body.push(compactSymbolList(r.deps, 20));
      body.push("```");
    }
    body.push("");
    body.push("</details>");
  }
  body.push("");
  body.push(
    "<sub>[gitatlas](https://github.com/bajpayeeritik/gitatlas) · one sticky comment, updated in place</sub>"
  );

  const content = body.join("\n");
  const fp = crypto.createHash("sha1").update(content).digest("hex").slice(0, 16);
  return `${REPORT_MARKER}\n${content}\n<!-- gitatlas-fingerprint: ${fp} -->`;
}
