import { execFile, type ChildProcess } from "node:child_process";

export function terminateProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid || child.exitCode !== null) {
    return;
  }

  if (process.platform === "win32") {
    const killer = execFile(
      "taskkill",
      ["/pid", String(pid), "/T", "/F"],
      { windowsHide: true },
      (error) => {
        if (error) {
          child.kill("SIGTERM");
        }
      },
    );
    killer.unref();
    return;
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
    return;
  }

  const forceKill = setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // The process group has already exited.
    }
  }, 1500);
  forceKill.unref();
  child.once("close", () => clearTimeout(forceKill));
}
