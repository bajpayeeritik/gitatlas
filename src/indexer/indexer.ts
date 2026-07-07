import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { GraphDB } from "../graph/db.js";
import { languageForFile } from "./languages.js";
import { extractFile } from "./extract.js";
import type { IndexStats } from "../types.js";

const DEFAULT_EXCLUDES = new Set([
  "node_modules", ".git", ".codegraph", "dist", "build", "out", "target",
  "vendor", "venv", ".venv", "__pycache__", ".next", ".nuxt", "coverage",
  ".idea", ".vscode", "bin", "obj",
]);

function sha1(content: Buffer): string {
  return crypto.createHash("sha1").update(content).digest("hex");
}

/**
 * List indexable files, repo-relative with forward slashes.
 * Inside a git repo we use git's view (tracked + untracked-but-not-ignored)
 * so .gitignore is respected for free; otherwise walk with default excludes.
 */
export function listFiles(root: string): string[] {
  try {
    const out = execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard"],
      { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
    );
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && languageForFile(l));
  } catch {
    const results: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".") || DEFAULT_EXCLUDES.has(entry.name)) {
          continue;
        }
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (languageForFile(entry.name)) {
          results.push(path.relative(root, full).replace(/\\/g, "/"));
        }
      }
    };
    walk(root);
    return results;
  }
}

export interface IndexOptions {
  onProgress?: (msg: string) => void;
}

/** Bump when extraction logic changes so cached parses are invalidated. */
const EXTRACTOR_VERSION = "5";

/**
 * Index the repo incrementally: content-hash every candidate file, re-extract
 * only files whose hash changed, drop files that disappeared, then rebuild
 * the edge table (link phase). A full index is just this with an empty DB.
 */
export async function indexRepo(
  root: string,
  opts: IndexOptions = {}
): Promise<IndexStats> {
  const started = Date.now();
  const db = new GraphDB(root);
  try {
    if (db.getMeta("extractor_version") !== EXTRACTOR_VERSION) {
      db.db.exec("DELETE FROM files"); // cascades to symbols/refs/imports
      db.setMeta("extractor_version", EXTRACTOR_VERSION);
    }
    const known = db.getFileHashes();
    const current = listFiles(root);
    const currentSet = new Set(current);

    let filesRemoved = 0;
    for (const knownPath of known.keys()) {
      if (!currentSet.has(knownPath)) {
        db.removeFile(knownPath);
        filesRemoved++;
      }
    }

    let filesIndexed = 0;
    for (const rel of current) {
      const abs = path.join(root, rel);
      let content: Buffer;
      try {
        content = fs.readFileSync(abs);
      } catch {
        continue; // deleted between listing and reading
      }
      const hash = sha1(content);
      if (known.get(rel) === hash) continue;

      const lang = languageForFile(rel)!;
      const extraction = await extractFile(rel, content.toString("utf8"), lang);
      db.upsertFile(rel, hash, lang, extraction);
      filesIndexed++;
      if (filesIndexed % 100 === 0) {
        opts.onProgress?.(`indexed ${filesIndexed} files...`);
      }
    }

    let edges = 0;
    if (filesIndexed > 0 || filesRemoved > 0) {
      opts.onProgress?.("linking references...");
      edges = db.link();
      db.setMeta("last_indexed", new Date().toISOString());
    } else {
      edges = db.stats().edges;
    }

    const stats = db.stats();
    return {
      files: stats.files,
      symbols: stats.symbols,
      edges,
      durationMs: Date.now() - started,
      filesIndexed,
      filesRemoved,
    };
  } finally {
    db.close();
  }
}
