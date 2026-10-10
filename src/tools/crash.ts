import { existsSync, statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { diagnose, type Finding } from "../diagnostics/parse.js";
import type { Services } from "../services.js";
import { clip, fail, okText } from "./result.js";
import { analyzeCrashInput } from "./schemas.js";

type A = z.infer<z.ZodObject<typeof analyzeCrashInput>>;

async function newest(dir: string, filter: (f: string) => boolean): Promise<string | undefined> {
  if (!existsSync(dir)) return undefined;
  const files = (await readdir(dir)).filter(filter).map((f) => path.join(dir, f));
  return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

export function findingLine(f: Finding): string {
  const loc = f.file ? ` ${f.file}${f.line ? `:${f.line}` : ""}` : "";
  return `${f.severity} ${f.kind}${f.plugin ? ` [${f.plugin}]` : ""}${loc}: ${clip(f.message, 300)}${f.also?.length ? ` (also ${f.also.join(", ")})` : ""}${f.suggestion ? `\n  → ${f.suggestion}` : ""}${f.evidence && f.evidence !== f.message && !f.file ? `\n  log: ${clip(f.evidence, 200)}` : ""}`;
}

export async function analyzeCrash(_services: Services, a: A) {
  let text = a.log;
  let origin = "pasted text";
  if (!text && a.path) {
    if (!existsSync(a.path)) return fail(`File not found: ${a.path}`);
    text = await readFile(a.path, "utf8");
    origin = a.path;
  }
  if (!text && a.serverDir) {
    const dir = path.resolve(a.serverDir);
    const crash = await newest(path.join(dir, "crash-reports"), (f) => f.endsWith(".txt"));
    const latest = path.join(dir, "logs", "latest.log");
    const file = crash && (!existsSync(latest) || statSync(crash).mtimeMs >= statSync(latest).mtimeMs - 60_000) ? crash : existsSync(latest) ? latest : crash;
    if (!file) return fail(`No crash-reports/*.txt or logs/latest.log under ${dir}.`);
    text = await readFile(file, "utf8");
    origin = file;
  }
  if (!text) return fail("Give log, path or serverDir.");
  const d = diagnose(text);
  const kind = { "crash-report": "Crash report", "server-log": "Server log", gradle: "Gradle output", maven: "Maven output", unknown: "Text" }[d.source];
  const srv = d.server ? ` [${[d.server.software, d.server.mc, d.server.java ? `Java ${d.server.java}` : "", d.server.nmsPackage].filter(Boolean).join(", ")}]` : "";
  const sorted = [...d.findings.filter((f) => f.severity === "error"), ...d.findings.filter((f) => f.severity !== "error")];
  const off = a.offset ?? 0;
  const lim = a.limit ?? 20;
  const shown = sorted.slice(off, off + lim);
  return okText(
    [
      `${kind} (${origin})${srv}: ${d.summary}`,
      ...(d.culprit ? [`culprit: ${d.culprit.plugin} (${d.culprit.confidence}: ${d.culprit.reasons.join("; ")})`] : []),
      ...shown.map(findingLine),
      ...(sorted.length > off + lim ? [`… ${sorted.length - off - lim} more: offset=${off + lim}`] : []),
      ...(!d.findings.length && d.rootException ? [`root exception: ${clip(d.rootException, 300)}`] : []),
    ].join("\n"),
  );
}
