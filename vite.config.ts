import { defineConfig, type Plugin, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Dev backend: serves Claude Code session files over localhost.
 *
 * This is the "adapter" the frontend talks to. In the Tauri build the same
 * two endpoints become invoke() commands in Rust; the frontend is unchanged.
 * Read-only by construction — this app never writes to session files.
 */
function sessionApi(): Plugin {
  // FOOLSCAP_ROOT points the viewer at any archive directory — a copied
  // archive from another machine, a shared fixture set, a backup.
  const root = process.env.FOOLSCAP_ROOT ?? join(homedir(), ".claude", "projects");

  return {
    name: "foolscap-session-api",
    configureServer(server: ViteDevServer) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? "/", "http://localhost");

        try {
          if (url.pathname === "/api/projects") {
            const out: unknown[] = [];
            let projectDirs: string[] = [];
            try {
              projectDirs = await readdir(root);
            } catch {
              // ~/.claude/projects doesn't exist — empty state, not an error
            }

            for (const dir of projectDirs) {
              const projectPath = join(root, dir);
              let entries;
              try {
                entries = await readdir(projectPath, { withFileTypes: true });
              } catch {
                continue;
              }
              const sessions = [];
              for (const e of entries) {
                // Top-level *.jsonl files are main sessions. Subdirectories
                // hold subagent transcripts and task files — v0.2 territory.
                if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
                const filePath = join(projectPath, e.name);
                const s = await stat(filePath);
                if (s.size === 0) continue;
                sessions.push({
                  id: e.name.replace(/\.jsonl$/, ""),
                  file: filePath,
                  bytes: s.size,
                  modified: s.mtimeMs,
                });
              }
              if (sessions.length > 0) {
                sessions.sort((a, b) => b.modified - a.modified);
                out.push({ dir, sessions });
              }
            }

            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify(out));
            return;
          }

          if (url.pathname === "/api/session") {
            const file = url.searchParams.get("file") ?? "";
            // Path containment: only files inside ~/.claude/projects,
            // only .jsonl. The adapter is the trust boundary.
            if (!file.startsWith(root) || !file.endsWith(".jsonl")) {
              res.statusCode = 403;
              res.end("forbidden");
              return;
            }
            const raw = await readFile(file, "utf8");
            res.setHeader("content-type", "application/x-ndjson");
            res.end(raw);
            return;
          }
        } catch (err) {
          res.statusCode = 500;
          res.end(String(err));
          return;
        }

        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), sessionApi()],
  clearScreen: false,
});
