/** PaperMC Fill v3 (downloads service) parsers. */
import { z } from "zod";

const ProjectSchema = z.object({ versions: z.record(z.string(), z.array(z.string())) }).passthrough();
const VersionSchema = z
  .object({
    version: z
      .object({
        id: z.string(),
        support: z.object({ status: z.string(), end: z.string().optional() }).passthrough().optional(),
        java: z.object({ version: z.object({ minimum: z.number().optional() }).passthrough().optional() }).passthrough().optional(),
      })
      .passthrough(),
    builds: z.array(z.number()).optional(),
  })
  .passthrough();
const BuildSchema = z
  .object({
    id: z.number(),
    channel: z.string().optional(),
    time: z.string().optional(),
    downloads: z.record(z.string(), z.object({ name: z.string(), url: z.string(), size: z.number().optional(), checksums: z.object({ sha256: z.string().optional() }).passthrough().optional() }).passthrough()),
  })
  .passthrough();

/** All Paper version ids, newest first as published (pre-releases included). */
export function parseFillProject(json: string): string[] {
  const p = ProjectSchema.parse(JSON.parse(json));
  return Object.values(p.versions).flat();
}

export interface PaperVersionInfo {
  id: string;
  support?: string;
  supportEnd?: string;
  javaMin?: number;
}
export function parseFillVersion(json: string): PaperVersionInfo {
  const v = VersionSchema.parse(JSON.parse(json)).version;
  return { id: v.id, support: v.support?.status, supportEnd: v.support?.end, javaMin: v.java?.version?.minimum };
}

export interface PaperBuild {
  id: number;
  channel?: string;
  time?: string;
  /** Download key (server:default, server:mojang) → file. */
  downloads: Record<string, { name: string; url: string; size?: number; sha256?: string }>;
}
export function parseFillBuild(json: string): PaperBuild {
  const b = BuildSchema.parse(JSON.parse(json));
  return {
    id: b.id,
    channel: b.channel,
    time: b.time,
    downloads: Object.fromEntries(Object.entries(b.downloads).map(([k, d]) => [k, { name: d.name, url: d.url, size: d.size, sha256: d.checksums?.sha256 }])),
  };
}
