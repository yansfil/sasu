import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** No operator executable is ever discovered by a fake suite. */
export function installFakeHide(root) {
  const bin = path.join(root, "fake-bin"); fs.mkdirSync(bin, { recursive: true });
  const source = fileURLToPath(new URL("./fake-hide.cjs", import.meta.url));
  fs.writeFileSync(path.join(bin, "hide"), `#!${process.execPath}\nrequire(${JSON.stringify(source)});\n`, { mode: 0o755 });
  const state = path.join(root, "hide-fixture.json"), log = path.join(root, "hide-argv.log");
  return { bin, state, log, env: { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, HIDE_FAKE_STATE: state, HIDE_FAKE_LOG: log }, argv: () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [] };
}

/** A missing real candidate is a test failure; it never selects an installed app. */
export function requireRealHide() {
  const candidate = process.env.SASU_TEST_HIDE;
  if (!candidate || !path.isAbsolute(candidate)) throw new Error("SASU_TEST_HIDE must name the exact pinned candidate hide executable");
  fs.accessSync(candidate, fs.constants.X_OK);
  const resources = path.dirname(candidate);
  const platform = process.platform === "darwin" && process.arch === "arm64" ? "macos-aarch64" : process.platform === "linux" && process.arch === "x64" ? "linux-x86_64" : null;
  if (!platform) throw new Error("native Hide integration supports macOS arm64 and Linux x64");
  for (const executable of ["hided", "herdr", "hide-agent-hooks", `hide-host-helper-${platform}`]) fs.accessSync(path.join(resources, executable), fs.constants.X_OK);
  return { hide: candidate, hided: path.join(resources, "hided"), herdr: path.join(resources, "herdr"), resources };
}
