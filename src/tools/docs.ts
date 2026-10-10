import { z } from "zod";
import { searchJavadoc, javadocSets } from "../docs/javadoc.js";
import { DocsStore, loadDocSources, rank, snippet, type DocPage } from "../docs/search.js";
import { readProjectInfo } from "../project/info.js";
import type { Services } from "../services.js";
import { Notes } from "../sources/index.js";
import { compareMcVersions, parseMcVersion } from "../util/mcversion.js";
import { fail, okText } from "./result.js";
import { docsSearchInput } from "./schemas.js";

type A = z.infer<z.ZodObject<typeof docsSearchInput>>;
let shared: DocsStore | undefined;

export async function docsSearch(services: Services, a: A, injected?: DocsStore) {
  const store = injected ?? (shared ??= new DocsStore(services.config));
  let platform = a.platform;
  let mc = a.mcVersion;
  if (a.projectDir) {
    const info = await readProjectInfo(a.projectDir);
    platform ??= info.platform;
    mc ??= info.mcVersion || undefined;
  }
  const kinds = new Set(a.kinds ?? ["docs", "javadoc", "news"]);
  const topic = a.topic?.toLowerCase();
  const limit = a.limit ?? 6;
  const verify = a.verifyUrls !== false;
  const msgs: string[] = [];
  const warnings: string[] = [];
  const out: string[] = [];
  const used: string[] = [];

  // ---- docs + news (Markdown sources)
  const all = (await loadDocSources(services.config)).filter((s) => kinds.has(s.kind) && (!platform || s.platforms.includes(platform)));
  const pages: DocPage[] = [];
  const boost = new Map<DocPage, number>();
  await Promise.all(
    all.map(async (s) => {
      try {
        const ps = await store.load(s, warnings);
        const topical = ps.filter((p) => !topic || p.topics.includes(topic) || p.repoPath.toLowerCase().includes(topic));
        for (const p of topical) {
          if (s.kind === "news") {
            if (mc && parseMcVersion(p.version) && compareMcVersions(p.version, mc) > 0) continue; // posts about newer versions
            boost.set(p, mc && p.version === mc ? 1.6 : parseMcVersion(p.version) ? 0.8 : 0.6);
          }
          pages.push(p);
        }
        if (topical.length) used.push(s.title);
      } catch (e) {
        warnings.push(`${s.title} unavailable: ${(e as Error).message}`);
      }
    }),
  );
  const docHits: string[] = [];
  if (pages.length) {
    const seen = new Set<string>();
    let gone = 0;
    for (const h of rank(pages, a.query, (p) => boost.get(p) ?? 1)) {
      if (docHits.length >= limit) break;
      const key = `${h.page.url}#${h.section.anchor}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let url = h.page.url;
      let ok: boolean | undefined;
      if (verify) {
        ok = await store.verifyUrl(url);
        if (ok !== true && h.page.fallbackUrl && (await store.verifyUrl(h.page.fallbackUrl))) (url = h.page.fallbackUrl), (ok = true);
        if (ok === false) {
          gone++;
          continue;
        }
      }
      const code = a.includeCode === false ? undefined : h.section.code[0];
      const head = `${docHits.length + 1}. ${h.page.title}${h.section.heading && h.section.heading !== h.page.title ? ` › ${h.section.heading}` : ""}${h.page.kind === "news" ? ` (news${parseMcVersion(h.page.version) ? ` ${h.page.version}` : ""})` : ""}${verify && ok !== true ? " [UNVERIFIED URL]" : ""}\n   ${h.section.anchor ? `${url}#${h.section.anchor}` : url}\n   ${snippet(h.section.text, a.query, 240)}`;
      docHits.push(code ? `${head}\n   \`\`\`\n${(code.length > 500 ? `${code.slice(0, 500)}\n…` : code).split("\n").map((l) => `   ${l}`).join("\n")}\n   \`\`\`` : head);
    }
    if (gone) msgs.push(`${gone} matching page(s) skipped: URL returns 404.`);
  }

  // ---- javadoc
  const jdHits: string[] = [];
  if (kinds.has("javadoc") && (!topic || topic === "adventure" || topic === "api" || topic === "javadoc")) {
    const notes = new Notes();
    const sets = (await javadocSets(services, platform, mc, notes, msgs)).filter((s) => topic !== "adventure" || s.id === "adventure");
    const hits = await searchJavadoc(services, sets, a.query, Math.max(3, Math.ceil(limit / 2)), notes);
    for (const h of hits) {
      let tag = "";
      if (verify && h.kind === "type") {
        const ok = await store.verifyUrl(h.url);
        if (ok === false) continue;
        if (ok !== true) tag = " [UNVERIFIED URL]";
      }
      jdHits.push(`- ${h.name.replace(/^([\w.]+\.)(?=[A-Z])/, "")} (${h.set.title}${h.set.version !== "latest" ? ` ${h.set.version}` : ""})${tag}\n  ${h.url}`);
    }
    if (sets.length) used.push(sets.map((s) => `${s.title}${s.version !== "latest" ? ` ${s.version}` : ""}`).join(", "));
    warnings.push(...notes.warnings);
  }
  if (!docHits.length && !jdHits.length) return fail(`No matches for "${a.query}"${topic ? ` (topic ${topic})` : ""}. Searched: ${used.join("; ") || "nothing"}.${warnings.length ? ` ${warnings.join(" ")}` : ""}`);
  out.push(`"${a.query}"${platform ? ` ${platform}` : ""}${mc ? ` ${mc}` : ""}${topic ? ` [${topic}]` : ""} — searched: ${used.join("; ")}.`);
  out.push(...msgs.map((m) => `note: ${m}`), ...warnings.map((w) => `warning: ${w}`));
  if (docHits.length) out.push(...docHits);
  if (jdHits.length) out.push("javadoc:", ...jdHits);
  return okText(out.join("\n"));
}
