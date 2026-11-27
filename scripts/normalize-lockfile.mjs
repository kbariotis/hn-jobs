// Rewrite package-lock.json "resolved" URLs from a private mirror (Nexus/Artifactory style
// `https://<host>/repository/<repo>/...`) to the public npm registry. Build hosts (Vercel, CI)
// can't reach a private mirror, and the mirror proxies npmjs, so integrity hashes are unchanged.
// npm's default `replace-registry-host=npmjs` still installs through a configured mirror locally.
//
// Usage: node scripts/normalize-lockfile.mjs [--check]   (--check: exit 1 if anything is private)
import fs from "node:fs";

const FILE = new URL("../package-lock.json", import.meta.url);
const PUBLIC = "https://registry.npmjs.org/";
const MIRROR = /^https:\/\/[^/]+\/repository\/[^/]+\//;

const lock = JSON.parse(fs.readFileSync(FILE, "utf8"));
let changed = 0;
const leftovers = [];
for (const [name, pkg] of Object.entries(lock.packages ?? {})) {
  if (!pkg.resolved || pkg.resolved.startsWith(PUBLIC)) {
    continue;
  }
  if (MIRROR.test(pkg.resolved)) {
    pkg.resolved = pkg.resolved.replace(MIRROR, PUBLIC);
    changed++;
  } else {
    leftovers.push(`${name}: ${new URL(pkg.resolved).host}`);
  }
}

if (process.argv.includes("--check")) {
  if (changed || leftovers.length) {
    console.error(
      `package-lock.json has ${changed + leftovers.length} non-public URLs. ` +
        "Run: node scripts/normalize-lockfile.mjs",
    );
    process.exit(1);
  }
  console.log("package-lock.json: all resolved URLs are on registry.npmjs.org");
} else {
  fs.writeFileSync(FILE, JSON.stringify(lock, null, 2) + "\n");
  console.log(`Rewrote ${changed} URLs to ${PUBLIC}`);
  if (leftovers.length) {
    console.warn(`Not rewritten (unknown mirror format):\n  ${leftovers.join("\n  ")}`);
    process.exitCode = 1;
  }
}
