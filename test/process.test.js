const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const test = require("node:test");
const { terminateProcessTree } = require("../dist/process.js");

test("terminateProcessTree stops a detached process tree", async (context) => {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `const { spawn } = require("node:child_process");
       const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
       process.stdout.write(String(descendant.pid));
       setInterval(() => {}, 1000);`,
    ],
    {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    },
  );
  const [pidOutput] = await once(child.stdout, "data");
  const descendantPid = Number(pidOutput.toString());
  context.after(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    try {
      process.kill(descendantPid, "SIGKILL");
    } catch {
      // The descendant exited with its process group.
    }
  });

  const closed = once(child, "close");
  terminateProcessTree(child);
  const [code, signal] = await closed;

  assert.ok(code !== 0 || signal !== null);
  await assertProcessExited(descendantPid);
});

async function assertProcessExited(pid) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") {
        return;
      }
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`Descendant process ${pid} was not terminated`);
}
