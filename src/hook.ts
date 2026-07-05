import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MARKER = "# codegraph auto-update";
const HOOKS = ["post-commit", "post-merge", "post-checkout"];

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Install git hooks that incrementally update the graph after every commit,
 * merge, and branch switch. Appends to existing hooks rather than clobbering
 * them.
 */
export function installHooks(root: string): string[] {
  const gitDir = path.join(root, ".git");
  if (!fs.existsSync(gitDir)) {
    throw new Error(`${root} is not a git repository (no .git directory).`);
  }
  const hooksDir = path.join(gitDir, "hooks");
  fs.mkdirSync(hooksDir, { recursive: true });

  const cliPath = toPosix(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "cli.js")
  );
  const nodePath = toPosix(process.execPath);
  const command = `${MARKER}\n"${nodePath}" "${cliPath}" update --root "${toPosix(root)}" --quiet || true\n`;

  const installed: string[] = [];
  for (const hook of HOOKS) {
    const hookPath = path.join(hooksDir, hook);
    if (fs.existsSync(hookPath)) {
      const existing = fs.readFileSync(hookPath, "utf8");
      if (existing.includes(MARKER)) continue; // already installed
      fs.writeFileSync(hookPath, existing.trimEnd() + "\n\n" + command);
    } else {
      fs.writeFileSync(hookPath, `#!/bin/sh\n${command}`);
    }
    try {
      fs.chmodSync(hookPath, 0o755);
    } catch {
      // Windows: chmod is a no-op; git-bash executes hooks regardless
    }
    installed.push(hook);
  }
  return installed;
}

export function uninstallHooks(root: string): string[] {
  const hooksDir = path.join(root, ".git", "hooks");
  const removed: string[] = [];
  for (const hook of HOOKS) {
    const hookPath = path.join(hooksDir, hook);
    if (!fs.existsSync(hookPath)) continue;
    const lines = fs.readFileSync(hookPath, "utf8").split("\n");
    const idx = lines.findIndex((l) => l.includes(MARKER));
    if (idx < 0) continue;
    lines.splice(idx, 2); // marker line + command line
    const rest = lines.join("\n").trim();
    if (rest === "#!/bin/sh" || rest === "") {
      fs.unlinkSync(hookPath);
    } else {
      fs.writeFileSync(hookPath, rest + "\n");
    }
    removed.push(hook);
  }
  return removed;
}
