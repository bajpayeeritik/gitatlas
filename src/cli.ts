#!/usr/bin/env node
import { Command } from "commander";
import path from "node:path";
import { indexRepo } from "./indexer/indexer.js";
import { GraphDB } from "./graph/db.js";
import { findContext } from "./graph/rank.js";
import { compactSymbolList, repoMap } from "./graph/format.js";
import { serveMcp } from "./mcp/server.js";
import { installHooks, uninstallHooks } from "./hook.js";

const program = new Command();

program
  .name("codegraph")
  .description(
    "Code knowledge graph: index your repo, keep it fresh on every commit, and serve it to AI tools over MCP."
  )
  .version("0.1.0");

function resolveRoot(opts: { root?: string }): string {
  return path.resolve(opts.root ?? process.cwd());
}

program
  .command("index")
  .description("Build (or incrementally refresh) the code graph for a repo")
  .option("-r, --root <path>", "repository root", process.cwd())
  .action(async (opts) => {
    const root = resolveRoot(opts);
    console.log(`Indexing ${root} ...`);
    const stats = await indexRepo(root, {
      onProgress: (m) => console.log(`  ${m}`),
    });
    console.log(
      `Done in ${stats.durationMs}ms: ${stats.files} files, ${stats.symbols} symbols, ` +
        `${stats.edges} edges (${stats.filesIndexed} re-indexed, ${stats.filesRemoved} removed).`
    );
  });

program
  .command("update")
  .description("Incrementally update the graph (used by git hooks)")
  .option("-r, --root <path>", "repository root", process.cwd())
  .option("-q, --quiet", "suppress output", false)
  .action(async (opts) => {
    const root = resolveRoot(opts);
    const stats = await indexRepo(root);
    if (!opts.quiet) {
      console.log(
        `Updated in ${stats.durationMs}ms: ${stats.filesIndexed} files re-indexed, ` +
          `${stats.filesRemoved} removed, ${stats.symbols} symbols, ${stats.edges} edges.`
      );
    }
  });

program
  .command("serve")
  .description("Run the MCP server (stdio) so AI tools can query the graph")
  .option("-r, --root <path>", "repository root", process.cwd())
  .action(async (opts) => {
    await serveMcp(resolveRoot(opts));
  });

program
  .command("install-hook")
  .description("Install git hooks that auto-update the graph on every commit/merge/checkout")
  .option("-r, --root <path>", "repository root", process.cwd())
  .action((opts) => {
    const installed = installHooks(resolveRoot(opts));
    console.log(
      installed.length > 0
        ? `Installed hooks: ${installed.join(", ")}`
        : "Hooks were already installed."
    );
  });

program
  .command("uninstall-hook")
  .description("Remove codegraph git hooks")
  .option("-r, --root <path>", "repository root", process.cwd())
  .action((opts) => {
    const removed = uninstallHooks(resolveRoot(opts));
    console.log(
      removed.length > 0
        ? `Removed from hooks: ${removed.join(", ")}`
        : "No codegraph hooks found."
    );
  });

program
  .command("stats")
  .description("Show graph statistics")
  .option("-r, --root <path>", "repository root", process.cwd())
  .action((opts) => {
    const db = new GraphDB(resolveRoot(opts));
    const s = db.stats();
    console.log(
      `files: ${s.files}\nsymbols: ${s.symbols}\nreferences: ${s.refs}\nedges: ${s.edges}\n` +
        `last indexed: ${db.getMeta("last_indexed") ?? "never"}`
    );
    db.close();
  });

program
  .command("symbol <name>")
  .description("Look up a symbol by name")
  .option("-r, --root <path>", "repository root", process.cwd())
  .action((name, opts) => {
    const db = new GraphDB(resolveRoot(opts));
    const rows = db.findSymbols(name);
    if (rows.length === 0) console.log(`No symbol named '${name}'.`);
    for (const s of rows) {
      console.log(`${s.kind} ${s.qualified_name}  ${s.path}:${s.start_line}-${s.end_line}`);
      console.log(`  ${s.signature}`);
    }
    db.close();
  });

program
  .command("callers <name>")
  .description("List everything that calls/references a symbol")
  .option("-r, --root <path>", "repository root", process.cwd())
  .action((name, opts) => {
    const db = new GraphDB(resolveRoot(opts));
    const targets = db.findSymbols(name);
    if (targets.length === 0) {
      console.log(`No symbol named '${name}'.`);
    } else {
      const callers = db.callersOf(targets.map((t) => t.id));
      console.log(`${callers.length} caller(s) of '${name}':`);
      console.log(compactSymbolList(callers));
    }
    db.close();
  });

program
  .command("callees <name>")
  .description("List everything a symbol calls/references")
  .option("-r, --root <path>", "repository root", process.cwd())
  .action((name, opts) => {
    const db = new GraphDB(resolveRoot(opts));
    const sources = db.findSymbols(name);
    if (sources.length === 0) {
      console.log(`No symbol named '${name}'.`);
    } else {
      const callees = db.calleesOf(sources.map((s) => s.id));
      console.log(`'${name}' calls/references ${callees.length} indexed symbol(s):`);
      console.log(compactSymbolList(callees));
    }
    db.close();
  });

program
  .command("outline <file>")
  .description("List all symbols defined in a file")
  .option("-r, --root <path>", "repository root", process.cwd())
  .action((file, opts) => {
    const db = new GraphDB(resolveRoot(opts));
    const rows = db.fileSymbols(file.replace(/\\/g, "/"));
    if (rows.length === 0) console.log(`No indexed symbols in '${file}'.`);
    for (const s of rows) {
      console.log(`${s.kind} ${s.qualified_name}  :${s.start_line}-${s.end_line}`);
      console.log(`  ${s.signature}`);
    }
    db.close();
  });

program
  .command("impact <file>")
  .description("Blast radius: symbols elsewhere that depend on this file")
  .option("-r, --root <path>", "repository root", process.cwd())
  .action((file, opts) => {
    const db = new GraphDB(resolveRoot(opts));
    const p = file.replace(/\\/g, "/");
    const defined = db.fileSymbols(p);
    if (defined.length === 0) {
      console.log(`No indexed symbols in '${p}'.`);
    } else {
      const direct = db.callersOf(defined.map((d) => d.id));
      const external = direct.filter((s) => s.path !== p);
      console.log(`${defined.length} symbols defined; ${external.length} external dependent(s):`);
      console.log(compactSymbolList(external));
    }
    db.close();
  });

program
  .command("repo-map")
  .description("Compact orientation map: most central symbols, signatures only")
  .option("-r, --root <path>", "repository root", process.cwd())
  .option("-b, --budget <tokens>", "token budget", "1200")
  .action((opts) => {
    const db = new GraphDB(resolveRoot(opts));
    console.log(repoMap(db, parseInt(opts.budget, 10)));
    db.close();
  });

program
  .command("context <query...>")
  .description("Rank + pack the most relevant code snippets for a query")
  .option("-r, --root <path>", "repository root", process.cwd())
  .option("-b, --budget <tokens>", "token budget", "3000")
  .action((queryWords, opts) => {
    const root = resolveRoot(opts);
    const db = new GraphDB(root);
    const { chunks, brief } = findContext(
      db, root, queryWords.join(" "), parseInt(opts.budget, 10)
    );
    if (chunks.length === 0) console.log("No relevant symbols found.");
    for (const c of chunks) {
      console.log(
        `\n### ${c.symbol.kind} ${c.symbol.qualified_name} (${c.symbol.path}:${c.symbol.start_line})`
      );
      console.log(c.snippet);
    }
    if (brief.length > 0) {
      console.log("\nAlso relevant:");
      for (const b of brief) {
        console.log(`  ${b.symbol.qualified_name} ${b.symbol.path}:${b.symbol.start_line}`);
      }
    }
    db.close();
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
