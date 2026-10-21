"use strict";
// Start harness.cjs the way Claudexor starts its daemon (packages/cli/src/daemon-launch.ts):
// detached, stdio ["ignore", "ignore", "pipe"], no windowsHide. On Windows that parent
// has no console, so a console grandchild cannot borrow this CI step's (hidden) one.
// Whether the parent really had none is read from observer evidence, not assumed.
// The harness gets an EXPLICIT scratch-only environment (nothing inherited from the
// runner or the operator): a scratch HOME/USERPROFILE/APPDATA/TEMP under <out>-scratch.
// usage: node mimic-launch.cjs --checkout <repo> --label <name> --out <dir> [--hold-ms N] [--posix-dry-run]
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const argv = process.argv.slice(2);
const option = (name) => argv[argv.indexOf(`--${name}`) + 1];
const out = path.resolve(option("out"));
const label = option("label");
fs.mkdirSync(out, { recursive: true });
// Beside <out>, not inside it: the fixture copies of node.exe must not ride the uploaded evidence.
const scratch = path.join(`${out}-scratch`, label);
const home = path.join(scratch, "home");
const tmp = path.join(scratch, "tmp");
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(tmp, { recursive: true });
const nodeDir = path.dirname(process.execPath);
const env = { HOME: home, USERPROFILE: home, CLAUDEXOR_CONFIG_DIR: path.join(home, "claudexor") };
if (process.platform === "win32") {
  const root = process.env.SystemRoot;
  Object.assign(env, {
    PATH: `${nodeDir};${root}\\System32;${root}`,
    SystemRoot: root,
    windir: root,
    ComSpec: process.env.ComSpec || `${root}\\System32\\cmd.exe`,
    PATHEXT: process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD",
    TEMP: tmp,
    TMP: tmp,
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
  });
} else Object.assign(env, { PATH: `${nodeDir}:/usr/bin:/bin`, TMPDIR: tmp });
fs.writeFileSync(path.join(out, `harness-${label}.env-keys.json`), JSON.stringify(Object.keys(env).sort()));

const child = spawn(process.execPath, [path.join(__dirname, "harness.cjs"), ...argv], {
  detached: true,
  stdio: ["ignore", "ignore", "pipe"],
  cwd: out,
  env,
});
const stderr = fs.createWriteStream(path.join(out, `harness-${label}.stderr.log`));
child.stderr.pipe(stderr);
const deadline = setTimeout(() => {
  fs.writeFileSync(path.join(out, `harness-${label}.exit.json`), JSON.stringify({ timeout: true, pid: child.pid }));
  try { child.kill(); } catch { /* already gone */ }
  process.exit(2);
}, 15 * 60 * 1000);
child.on("close", (code, signal) => {
  clearTimeout(deadline);
  fs.writeFileSync(path.join(out, `harness-${label}.exit.json`), JSON.stringify({ code, signal, pid: child.pid }));
  process.exit(code === 0 ? 0 : (code ?? 1)); // the harness's 3 = a scenario failed
});
