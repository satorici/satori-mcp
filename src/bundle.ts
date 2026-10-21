/** Playbook bundles: a reproducible zip of the playbook plus the files it references. */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { zipSync, type Zippable } from "fflate";
import { parse } from "yaml";
import { client } from "./api.js";
import { SATORI_HOME } from "./constants.js";

// Fixed timestamp so identical inputs give identical zips (the sha256 is the cache key).
const ZIP_MTIME = new Date(1980, 0, 1);

export function* dumpFileUris(playbook: unknown): Generator<string> {
  if (playbook === null || typeof playbook !== "object" || Array.isArray(playbook)) return;
  for (const value of Object.values(playbook)) {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      yield* dumpFileUris(value);
    } else if (Array.isArray(value)) {
      if (value.length === 1 && Array.isArray(value[0])) {
        for (const i of value[0]) {
          if (i !== null && typeof i === "object" && !Array.isArray(i) && i.file) yield i.file;
        }
      } else if (
        value.every((i) => typeof i === "string" && (i.startsWith("file://") || i.startsWith("satori://")))
      ) {
        yield* value.filter((i: string) => i.startsWith("file://"));
      }
    }
  }
}

export function makeBundle(playbookPath: string): Uint8Array {
  const raw = readFileSync(playbookPath);
  const playbook = parse(raw.toString("utf-8"));
  const playbookDir = dirname(playbookPath);

  const files: Zippable = { ".satori.yml": [new Uint8Array(raw), { mtime: ZIP_MTIME, level: 0 }] };
  for (const uri of dumpFileUris(playbook)) {
    const path = uri.slice("file://".length);
    if (!(path in files)) {
      files[path] = [new Uint8Array(readFileSync(join(playbookDir, path))), { mtime: ZIP_MTIME, level: 0 }];
    }
  }
  return zipSync(files);
}

/** bundle sha256 -> bundle id, shared with the satori-v2 CLI; entries expire after a day. */
export const BundleCache = {
  dir: join(SATORI_HOME, "bundle_cache"),
  validMs: 24 * 60 * 60 * 1000,

  getBundleId(sha: string): string | undefined {
    mkdirSync(this.dir, { recursive: true });
    const cutoff = Date.now() - this.validMs;
    for (const name of readdirSync(this.dir)) {
      const path = join(this.dir, name);
      const stat = statSync(path);
      if (stat.isFile() && stat.mtimeMs < cutoff) unlinkSync(path);
    }
    try {
      return readFileSync(join(this.dir, sha), "utf-8");
    } catch {
      return undefined;
    }
  },

  setBundleId(sha: string, bundleId: string): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, sha), bundleId);
  },
};

/** Upload a bundle (or reuse a cached upload) and return its `bundle://` source. */
export async function uploadBundle(bundle: Uint8Array): Promise<string> {
  const sha = createHash("sha256").update(bundle).digest("hex");
  let bundleId = BundleCache.getBundleId(sha);
  if (!bundleId) {
    const form = new FormData();
    form.append("bundle", new Blob([bundle as Uint8Array<ArrayBuffer>]), "upload");
    bundleId = await client.postForm("/bundles", form);
    BundleCache.setBundleId(sha, bundleId);
  }
  return `bundle://${bundleId}`;
}
