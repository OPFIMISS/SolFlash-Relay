const { spawnSync } = require("node:child_process");
const path = require("node:path");

const target = process.argv[2];
if (!new Set(["portable", "nsis"]).has(target)) {
  throw new Error("Usage: node scripts/package-target.cjs <portable|nsis>");
}

const cache = path.join(process.env.LOCALAPPDATA, "electron-builder", "Cache", "nsis");
const env = {
  ...process.env,
  ELECTRON_BUILDER_NSIS_DIR: path.join(cache, "nsis-3.0.4.1"),
  ELECTRON_BUILDER_NSIS_RESOURCES_DIR: path.join(cache, "nsis-resources-3.4.1"),
};
const suffix = target === "portable" ? "portable" : "setup";
const artifact = `SolFlash-Relay-\${version}-x64-${suffix}.\${ext}`;
const builder = path.join("node_modules", ".bin", "electron-builder.cmd");
const result = spawnSync(
  builder,
  [
    "--win",
    target,
    "--prepackaged",
    path.join("release", "win-unpacked"),
    `--config.artifactName=${artifact}`,
  ],
  { cwd: process.cwd(), env, stdio: "inherit", shell: true },
);
process.exit(result.status ?? 1);
