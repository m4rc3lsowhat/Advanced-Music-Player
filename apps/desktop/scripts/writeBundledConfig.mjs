import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDirectory, "..");
const repoRoot = path.resolve(desktopRoot, "../..");
const outputPath = path.join(desktopRoot, "dist-electron", "bundled-desktop-config.json");
const managedKeys = [
  "SPOTIFY_CLIENT_ID",
  "SOUNDCLOUD_CLIENT_ID",
  "DISCORD_CLIENT_ID"
];

for (const envPath of [
  path.join(repoRoot, ".env"),
  path.join(repoRoot, ".env.local"),
  path.join(desktopRoot, ".env"),
  path.join(desktopRoot, ".env.local")
]) {
  loadEnv({ path: envPath, override: false });
}

const bundledConfig = Object.fromEntries(
  managedKeys
    .map((key) => [key, process.env[key]?.trim() || ""])
    .filter(([, value]) => value)
);

await fs.mkdir(path.dirname(outputPath), { recursive: true });

if (Object.keys(bundledConfig).length === 0) {
  await fs.rm(outputPath, { force: true });
  console.log("[bundled-config] No build-time desktop config detected. Skipping bundled OAuth config.");
  process.exit(0);
}

await fs.writeFile(outputPath, JSON.stringify(bundledConfig, null, 2), "utf8");
console.log(`[bundled-config] Wrote ${outputPath}`);
