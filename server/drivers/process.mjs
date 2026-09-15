import { spawn } from "node:child_process";

/** Stop a launched adapter and its descendants without keeping Node alive. */
export function terminateProcessTree(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform !== "win32") {
    child.kill();
    return;
  }
  // Agent adapters are commonly npm .cmd shims on Windows. Killing cmd.exe
  // alone leaves node.exe running, so terminate the exact PID tree.
  const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
    windowsHide: true,
    stdio: "ignore",
  });
  killer.unref();
}
