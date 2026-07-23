import { mkdir, rm, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

async function collectTs(dir) {
  const out = [];
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...(await collectTs(p)));
    else if (ent.name.endsWith(".ts") && !ent.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

const entries = await collectTs(join(root, "src"));
await build({
  entryPoints: entries,
  outdir: dist,
  outbase: join(root, "src"),
  platform: "node",
  format: "esm",
  target: "node22",
  bundle: false,
  sourcemap: true,
});
console.log(`built ${entries.length} files → dist/`);
