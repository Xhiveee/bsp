import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/** Download a binary once (atomic write; sha1/sha256-checked when known). Returns the path. */
export async function downloadFile(url: string, dest: string, o: { userAgent: string; sha1?: string; sha256?: string; offline?: boolean }): Promise<string> {
  const algo = o.sha256 ? "sha256" : o.sha1 ? "sha1" : undefined;
  const want = o.sha256 ?? o.sha1;
  if (existsSync(dest)) {
    if (!algo) return dest;
    const h = createHash(algo).update(await readFile(dest)).digest("hex");
    if (h === want) return dest;
  }
  if (o.offline) throw new Error(`Offline mode and ${path.basename(dest)} is not cached (${url}).`);
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": o.userAgent } });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} for ${url}`);
        if (res.status === 404) throw Object.assign(err, { fatal: true });
        throw err;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (algo) {
        const h = createHash(algo).update(buf).digest("hex");
        if (h !== want) throw new Error(`${algo} mismatch for ${url}`);
      }
      await mkdir(path.dirname(dest), { recursive: true });
      const tmp = `${dest}.${process.pid}.tmp`;
      await writeFile(tmp, buf);
      await rename(tmp, dest);
      return dest;
    } catch (e) {
      last = e;
      if ((e as { fatal?: boolean }).fatal) break;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}
