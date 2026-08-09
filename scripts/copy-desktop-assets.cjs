const { copyFileSync, mkdirSync } = require("node:fs");
const path = require("node:path");

const target = path.join("dist", "desktop");
mkdirSync(target, { recursive: true });
copyFileSync(path.join("src", "desktop", "preload.cjs"), path.join(target, "preload.cjs"));
