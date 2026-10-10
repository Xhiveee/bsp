/**
 * Diagnosis of Bukkit/Spigot/Paper server logs, crash reports and build output (javac, Maven, Gradle).
 * Pure text → findings. Only message formats of the server/JVM/build tools are matched; they are stable across versions.
 */

export type FindingKind =
  | "compile_error"
  | "compile_warning"
  | "dependency_resolution"
  | "jvm_mismatch"
  | "toolchain_missing"
  | "build_failure"
  | "plugin_load"
  | "missing_dependency"
  | "api_version"
  | "plugin_yml"
  | "plugin_error"
  | "nms_mismatch"
  | "class_not_found"
  | "linkage_error"
  | "async_access"
  | "watchdog"
  | "duplicate_plugin"
  | "crash"
  | "out_of_memory"
  | "eula"
  | "network";

export interface Finding {
  kind: FindingKind;
  severity: "error" | "warning" | "info";
  message: string;
  file?: string;
  line?: number;
  plugin?: string;
  /** The log line this came from. */
  evidence?: string;
  suggestion?: string;
}

export interface Diagnosis {
  source: "crash-report" | "server-log" | "gradle" | "maven" | "unknown";
  summary: string;
  findings: Finding[];
  server?: { software?: string; mc?: string; java?: number; nmsPackage?: string };
  culprit?: { plugin: string; confidence: "high" | "medium" | "low"; reasons: string[] };
  rootException?: string;
}

/** class file major → Java release (52 = Java 8). */
export const classMajorToJava = (major: number) => major - 44;

function push(list: Finding[], f: Finding): void {
  if (!list.some((x) => x.kind === f.kind && x.message === f.message && x.file === f.file && x.line === f.line)) list.push(f);
}

export function detectSource(text: string): Diagnosis["source"] {
  if (/---- Minecraft Crash Report ----/.test(text)) return "crash-report";
  if (/\[INFO\] (BUILD|Building|Scanning for projects)|\[ERROR\] Failed to execute goal|BUILD FAILURE/.test(text)) return "maven";
  if (/\* What went wrong:|> Task :|BUILD (FAILED|SUCCESSFUL)|Gradle \d/.test(text)) return "gradle";
  if (/\[(Server thread|main|ServerMain|Craft Scheduler Thread[^\]]*|Paper Watchdog Thread|Spigot Watchdog Thread)\/(INFO|WARN|ERROR)\]/.test(text) || /\[\d\d:\d\d:\d\d (INFO|WARN|ERROR)\]/.test(text)) return "server-log";
  return "unknown";
}

const strip = (l: string) => l.replace(/^\[[^\]]*\]\s*(\[[^\]]*\/(?:INFO|WARN|ERROR|FATAL)\]:?\s*)?/, "").replace(/^\[\d\d:\d\d:\d\d (?:INFO|WARN|ERROR)\]:?\s*/, "").trim();
const NMS_PKG = /(?:net[./]minecraft[./]server|org[./]bukkit[./]craftbukkit)[./](v\d+_\d+_R\d+)/;

export function diagnose(text: string): Diagnosis {
  const lines = text.split(/\r?\n/);
  const findings: Finding[] = [];
  const source = detectSource(text);
  const server: NonNullable<Diagnosis["server"]> = {};
  let m: RegExpExecArray | null;
  if ((m = /This server is running (\w+) version (\S+) \(MC: ([\d.]+)\)/.exec(text))) Object.assign(server, { software: m[1], mc: m[3] });
  else if ((m = /Starting minecraft server version ([\w.-]+)/.exec(text))) server.mc = m[1];
  if ((m = /Running Java (\d+)|Java version: (\d+)|java\.version[=:] ?"?(\d+)/.exec(text))) server.java = Number(m[1] ?? m[2] ?? m[3]);
  if ((m = /org\.bukkit\.craftbukkit\.(v\d+_\d+_R\d+)\.CraftServer/.exec(text))) server.nmsPackage = m[1];
  /** plugin context of the current exception block (from the preceding error line) */
  let ctxPlugin: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = strip(raw);

    // ---- javac (Gradle style and Maven style) ----
    if ((m = /^(?:\[(ERROR|WARNING)\] )?(.*?\.(?:java|kt)):(?:(\d+):(?:(\d+):)? (error|warning|e|w): |\[(\d+),(\d+)\] )(.+)$/.exec(line))) {
      const sev = m[5] ? m[5].startsWith("e") : m[1] !== "WARNING";
      const details: string[] = [];
      for (let j = i + 1; j < Math.min(lines.length, i + 5); j++) {
        const d = strip(lines[j]!).replace(/^\[ERROR\]\s*/, "");
        if (/^(symbol|location|required|found|reason):/.test(d)) details.push(d.replace(/\s+/g, " "));
        else if (/\.(java|kt):/.test(d)) break;
      }
      const msg = m[8]!;
      push(findings, {
        kind: sev ? "compile_error" : "compile_warning",
        severity: sev ? "error" : "warning",
        file: m[2],
        line: Number(m[3] ?? m[6]),
        message: msg + (details.length ? ` (${details.join("; ")})` : ""),
        evidence: line,
        suggestion: /cannot find symbol|does not exist|cannot access/.test(msg) && /net\.minecraft|craftbukkit|symbol/.test(msg + details.join(" "))
          ? "Name differs in this version/mapping: search_server_source / translate_mapping; nms_validate for all refs."
          : undefined,
      });
      continue;
    }

    // ---- build tools / JVM ----
    if ((m = /Dependency requires at least JVM runtime version (\d+)\. This build uses a Java (\d+) JVM/.exec(line))) {
      push(findings, { kind: "jvm_mismatch", severity: "error", message: `A Gradle plugin needs Java ${m[1]} to run, Gradle runs on Java ${m[2]}.`, evidence: line, suggestion: `Run Gradle with JDK ${m[1]}+ (build picks it if installed).` });
      continue;
    }
    if ((m = /Unsupported class file major version (\d+)/.exec(line))) {
      push(findings, { kind: "jvm_mismatch", severity: "error", message: `Something compiled for Java ${classMajorToJava(Number(m[1]))} is read by a tool too old for it (often Gradle/Groovy).`, evidence: line, suggestion: "Upgrade the Gradle wrapper or run Gradle on an older JDK." });
      continue;
    }
    if ((m = /(\S+) has been compiled by a more recent version of the Java Runtime \(class file version (\d+)\.\d+\), this version of the Java Runtime only recognizes class file versions up to (\d+)\.\d+/.exec(line))) {
      const need = classMajorToJava(Number(m[2]));
      const have = classMajorToJava(Number(m[3]));
      push(findings, { kind: "jvm_mismatch", severity: "error", message: `Wrong Java: ${m[1]} needs Java ${need}, running on Java ${have}.`, plugin: ctxPlugin, evidence: line, suggestion: `Start the server with Java ${need}+, or compile the plugin for Java ${have} (release ${have}).` });
      continue;
    }
    if ((m = /(?:invalid target release|release version) (\d+)(?: not supported)?/.exec(line))) {
      push(findings, { kind: "jvm_mismatch", severity: "error", message: `The JDK running the build cannot compile for Java ${m[1]}.`, evidence: line, suggestion: `Use JDK ${m[1]}+ (build javaHome= or install it).` });
      continue;
    }
    if ((m = /(?:No matching toolchains found for requested specification|Cannot find a Java installation on your machine matching).*?languageVersion=(\d+)/.exec(line))) {
      push(findings, { kind: "toolchain_missing", severity: "error", message: `Gradle toolchain JDK ${m[1]} not found.`, evidence: line, suggestion: `Install JDK ${m[1]} or enable the foojay resolver in settings.gradle.` });
      continue;
    }
    if ((m = /Gradle requires JVM (\d+) or later to run|Your build is currently configured to use (?:incompatible )?Java (\d+)\S* and Gradle ([\d.]+)/.exec(line))) {
      push(findings, { kind: "jvm_mismatch", severity: "error", message: m[1] ? `Gradle needs Java ${m[1]}+.` : `Java ${m[2]} cannot run Gradle ${m[3]}.`, evidence: line });
      continue;
    }
    if ((m = /No matching variant of ([\w.-]+:[\w.-]+:[\w.+-]+) was found/.exec(line))) {
      const near = lines.slice(i, i + 25).join("\n");
      const g = /'org\.gradle\.plugin\.api-version' with value '([\d.]+)' and the consumer needed .*?'([\d.]+)'/.exec(near);
      if (g) {
        push(findings, { kind: "build_failure", severity: "error", message: `${m[1]} needs Gradle ${g[1]}+, the wrapper is ${g[2]}.`, evidence: line, suggestion: `Update the wrapper: ./gradlew wrapper --gradle-version ${g[1]} (or edit gradle/wrapper/gradle-wrapper.properties), or use an older plugin version.` });
        continue;
      }
    }
    if ((m = /Could not (?:resolve|find)(?: artifact)? ((?:[\w.-]+:){2,4}[\w.+-]+)/.exec(line)) || (m = /following artifacts could not be resolved: ([^,]+?)(?: \(absent\))?[,:]/.exec(line))) {
      const near = lines.slice(i, i + 8).join("\n");
      const status = /status code (\d{3})|status: (\d{3})/.exec(near);
      const art = m[1]!;
      const spigot = /org\.spigotmc:(spigot|minecraft-server)(:|$)/.test(art);
      push(findings, {
        kind: "dependency_resolution",
        severity: "error",
        message: `Could not resolve ${art}${status ? ` (HTTP ${status[1] ?? status[2]})` : ""}.`,
        evidence: line,
        suggestion: spigot
          ? "org.spigotmc:spigot / minecraft-server exist only in the local Maven repo after BuildTools (--remapped for remapped-mojang) — get_profile shows the command."
          : status && /^5/.test(status[1] ?? status[2] ?? "")
            ? "Repository server error — usually temporary. Retry."
            : "Check the version exists (list_versions mcVersion=) and the repository is declared (get_profile build=).",
      });
      continue;
    }
    if (/Could not GET '.*'.*status code 5\d\d|Connection reset|Read timed out|UnknownHostException|Could not transfer artifact/.test(line)) {
      push(findings, { kind: "network", severity: "warning", message: "Network/repository error while downloading.", evidence: line, suggestion: "Retry; check internet access or proxy." });
      continue;
    }
    if (/^\* What went wrong:/.test(line)) {
      const block: string[] = [];
      for (let j = i + 1; j < lines.length && !/^\* (Try|Exception is):/.test(lines[j]!); j++) if (lines[j]!.trim()) block.push(lines[j]!.trim());
      push(findings, { kind: "build_failure", severity: "error", message: block.slice(0, 6).join(" ").slice(0, 600), evidence: block[0] });
      continue;
    }
    if ((m = /^\[ERROR\] Failed to execute goal ([^:]+:[^:]+:[^:]+:\S+)(?: \([^)]*\))? on project ([\w.-]+): (.+)$/.exec(line))) {
      if (!findings.some((f) => f.kind === "dependency_resolution" || f.kind === "compile_error")) push(findings, { kind: "build_failure", severity: "error", message: `${m[1]} failed on ${m[2]}: ${m[3]!.slice(0, 400)}`, evidence: line });
      continue;
    }

    // ---- plugin loading ----
    if ((m = /Could not load (?:plugin )?'(?:plugins[\\/])?([^']+?\.jar)' in (?:folder )?'[^']*'/.exec(line))) {
      ctxPlugin = m[1]!.replace(/\.jar$/, "");
      const next = lines.slice(i + 1, i + 4).map(strip).find((l) => /Exception|Error/.test(l)) ?? "";
      const unknown = /UnknownDependencyException:\s*(.+)/.exec(next);
      const apiv = /Unsupported API version ([\w.-]+)/.exec(next);
      const low = /Plugin API version ([\w.-]+) is lower than the minimum allowed version/.exec(next);
      if (unknown) {
        const deps = /\[([^\]]+)\]/.exec(unknown[1]!)?.[1] ?? unknown[1]!;
        push(findings, { kind: "missing_dependency", severity: "error", plugin: ctxPlugin, message: `${m[1]} needs missing plugin(s): ${deps}.`, evidence: next, suggestion: `Install ${deps}, or move it to softdepend in plugin.yml if optional.` });
      } else if (apiv) {
        push(findings, { kind: "api_version", severity: "error", plugin: ctxPlugin, message: `${m[1]}: api-version ${apiv[1]} is newer than this server${server.mc ? ` (${server.mc})` : ""}.`, evidence: next, suggestion: "Lower api-version in plugin.yml to the oldest server version you support (minor before 1.20.5)." });
      } else if (low) {
        push(findings, { kind: "api_version", severity: "error", plugin: ctxPlugin, message: `${m[1]}: api-version ${low[1]} is below the server's minimum.`, evidence: next, suggestion: "Raise api-version (the server config may set a minimum)." });
      } else if (/InvalidDescriptionException/.test(next)) {
        push(findings, { kind: "plugin_yml", severity: "error", plugin: ctxPlugin, message: `${m[1]}: invalid plugin.yml — ${next.replace(/^.*InvalidDescriptionException:\s*/, "")}`, evidence: next, suggestion: "plugin.yml needs name, version, main (fully qualified class); check YAML syntax and that it is in the jar root." });
      } else {
        push(findings, { kind: "plugin_load", severity: "error", plugin: ctxPlugin, message: `${m[1]} could not be loaded${next ? `: ${next.slice(0, 300)}` : ""}.`, evidence: line });
      }
      continue;
    }
    if ((m = /UnknownDependencyException:\s*(?:Unknown\/missing dependency plugins: )?\[?([^\]]+)\]?\. Please download and install these plugins to run '([^']+)'/.exec(line))) {
      push(findings, { kind: "missing_dependency", severity: "error", plugin: m[2], message: `${m[2]} needs missing plugin(s): ${m[1]}.`, evidence: line, suggestion: `Install ${m[1]}, or make it softdepend.` });
      continue;
    }
    if ((m = /Cannot find main class [`'"]?([\w.$]+)/.exec(line))) {
      push(findings, { kind: "plugin_yml", severity: "error", plugin: ctxPlugin, message: `main class ${m[1]} not in the jar.`, evidence: line, suggestion: "Fix main: in plugin.yml (package + class) or check the jar contains the class (shading/relocation)." });
      continue;
    }
    if ((m = /Legacy plugin (.+?) does not specify an api-version/.exec(line))) {
      push(findings, { kind: "api_version", severity: "warning", plugin: m[1]!.split(" v")[0], message: `${m[1]} has no api-version → legacy mode (Material conversion, slow startup).`, evidence: line, suggestion: "Add api-version to plugin.yml." });
      continue;
    }
    if ((m = /Ambiguous plugin name [`']([^`']+)[`'] for files [`']([^`']+)[`'] and [`']([^`']+)[`']/.exec(line))) {
      push(findings, { kind: "duplicate_plugin", severity: "error", plugin: m[1], message: `Two jars of ${m[1]}: ${m[2]} and ${m[3]}.`, evidence: line, suggestion: "Remove one of them from plugins/." });
      continue;
    }

    // ---- plugin runtime errors (context lines) ----
    if ((m = /Error occurred while (enabling|disabling|loading) (.+?) v[\w.+-]+(?: \(Is it up to date\?\))?/.exec(line))) {
      ctxPlugin = m[2];
      push(findings, { kind: "plugin_error", severity: "error", plugin: m[2], message: `${m[2]} threw while ${m[1]}${excAfter(lines, i)}`, evidence: line });
      continue;
    }
    if ((m = /Could not pass event (\w+) to (.+?) v[\w.+-]+/.exec(line))) {
      ctxPlugin = m[2];
      push(findings, { kind: "plugin_error", severity: "error", plugin: m[2], message: `${m[2]} threw in a ${m[1]} handler${excAfter(lines, i)}`, evidence: line });
      continue;
    }
    if ((m = /(?:Unhandled exception executing command|Exception executing command) '([^']+)' in plugin (.+?) v[\w.+-]+/.exec(line))) {
      ctxPlugin = m[2];
      push(findings, { kind: "plugin_error", severity: "error", plugin: m[2], message: `${m[2]} threw executing /${m[1]}${excAfter(lines, i)}`, evidence: line });
      continue;
    }
    if ((m = /Plugin (.+?) v[\w.+-]+ generated an exception while executing task (\d+)/.exec(line))) {
      ctxPlugin = m[1];
      push(findings, { kind: "plugin_error", severity: "error", plugin: m[1], message: `${m[1]} scheduler task #${m[2]} threw${excAfter(lines, i)}`, evidence: line });
      continue;
    }
    if ((m = /Plugin (.+?) v[\w.+-]+ has failed to register events for (\S+) because (\S+) does not exist/.exec(line))) {
      push(findings, { kind: "class_not_found", severity: "error", plugin: m[1], message: `${m[1]}: listener ${m[2]} uses ${m[3]}, missing on this server.`, evidence: line, suggestion: "The listener references a class from another version/plugin; guard it or depend on the plugin." });
      continue;
    }

    // ---- JVM linkage / NMS ----
    if ((m = /(ClassNotFoundException|NoClassDefFoundError):? ([\w.$/]+)/.exec(line)) && !/Could not initialize class/.test(line)) {
      const cls = m[2]!.replace(/\//g, ".");
      const pkg = NMS_PKG.exec(cls)?.[1];
      const internal = /^(net\.minecraft|org\.bukkit\.craftbukkit)\./.test(cls);
      push(findings, {
        kind: internal ? "nms_mismatch" : "class_not_found",
        severity: "error",
        plugin: ctxPlugin,
        message: `${m[1]}: ${cls}${pkg ? ` — plugin built for NMS ${pkg}${server.nmsPackage ? `, server has ${server.nmsPackage}` : server.mc ? `, server is ${server.mc}` : ""}` : ""}`,
        evidence: line,
        suggestion: internal
          ? `Server internals differ from what the plugin was built against (version or mappings). Rebuild for this version; nms_validate targetVersion=${server.mc ?? "<server version>"} lists every broken ref.`
          : "A library/plugin class is missing at runtime: shade it into the jar or add the plugin to depend.",
      });
      continue;
    }
    if ((m = /(NoSuchMethodError|NoSuchFieldError|AbstractMethodError|IncompatibleClassChangeError):? '?(.+?)'?$/.exec(line))) {
      const internal = /net[./]minecraft|craftbukkit/.test(m[2]!);
      push(findings, {
        kind: internal ? "nms_mismatch" : "linkage_error",
        severity: "error",
        plugin: ctxPlugin,
        message: `${m[1]}: ${m[2]}`,
        evidence: line,
        suggestion: internal
          ? `NMS member changed between versions or mappings (dev Mojang names shipped without reobf?). nms_validate targetVersion=${server.mc ?? "<server version>"}; get_class to find the current name.`
          : "Built against a different API/library version than the server has; rebuild against the server's version.",
      });
      continue;
    }
    if ((m = /IllegalStateException: (Asynchronous [\w ]+!|.*(?:async|off-main|main thread).*)/i.exec(line))) {
      push(findings, { kind: "async_access", severity: "error", plugin: ctxPlugin, message: `Bukkit API used off the main thread: ${m[1]}`, evidence: line, suggestion: "Run world/entity/player changes on the main thread (runTask) or the region/entity scheduler on Folia." });
      continue;
    }
    if (/The server has stopped responding!|A single server tick took/.test(line)) {
      push(findings, { kind: "watchdog", severity: "error", message: "Server thread hung (watchdog).", evidence: line, suggestion: "See the main-thread stack below the watchdog message; the plugin frames show who blocked the tick (I/O, sleep, sync HTTP)." });
      continue;
    }
    if (/java\.lang\.OutOfMemoryError/.test(line)) {
      push(findings, { kind: "out_of_memory", severity: "error", message: line, evidence: line, suggestion: "Increase -Xmx (server) or org.gradle.jvmargs / MAVEN_OPTS (build)." });
      continue;
    }
    if (/You need to agree to the EULA in order to run the server/.test(line)) {
      push(findings, { kind: "eula", severity: "error", message: "The Minecraft EULA has not been accepted.", evidence: line, suggestion: "The server owner must read https://aka.ms/MinecraftEULA and set eula=true in eula.txt themselves — never on their behalf." });
    }
  }

  // a specific "plugin needs Gradle X" explains the generic resolution failures of the same artifact
  for (const f of findings.filter((x) => / needs Gradle /.test(x.message))) {
    const ga = f.message.split(" ")[0]!.split(":").slice(0, 2).join(":");
    for (let k = findings.length - 1; k >= 0; k--) if (findings[k] !== f && findings[k]!.message.includes(ga)) findings.splice(k, 1);
  }
  let rootException: string | undefined;
  if (source === "crash-report") {
    const di = lines.findIndex((l) => l.startsWith("Description:"));
    if (di >= 0) {
      const desc = lines[di]!.slice("Description:".length).trim();
      rootException = lines.slice(di + 1, di + 6).find((l) => /^\S+(Exception|Error)\b|^[\w.$]+: /.test(l.trim()))?.trim();
      push(findings, { kind: "crash", severity: "error", message: `${desc}${rootException ? ` — ${rootException}` : ""}` });
    }
  }
  if (!rootException) rootException = lines.map(strip).filter((l) => /^Caused by: /.test(l)).at(-1) ?? lines.map(strip).find((l) => /^[\w.$]+(?:Exception|Error)(?::|$)/.test(l));

  const culprit = findCulprit(text, findings);
  for (const f of findings) if (!f.plugin && culprit?.confidence === "high" && /nms|linkage|class_not_found|async/.test(f.kind)) f.plugin = culprit.plugin;
  const errors = findings.filter((f) => f.severity === "error");
  const summary =
    errors.length === 0
      ? findings.length
        ? `${findings.length} warning(s), no errors recognised.`
        : "No known error patterns recognised."
      : `${errors.length} error(s): ${[...new Set(errors.map((f) => f.kind))].join(", ")}${culprit ? `; likely culprit: ${culprit.plugin}` : ""}.`;
  return { source, summary, findings, server: Object.keys(server).length ? server : undefined, culprit, rootException };
}

/** ": <Exception: msg>" from the lines following a context line. */
function excAfter(lines: string[], i: number): string {
  for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
    const l = strip(lines[j]!);
    if (/^[\w.$]+(?:Exception|Error)\b/.test(l)) return `: ${l.slice(0, 240)}`;
  }
  return ".";
}

const NOT_PLUGIN = /^(paper|spigot|craftbukkit|bukkit|server|minecraft|purpur|folia|patched|mojang|java|netty|guava|gson|log4j|slf4j|datafixerupper|brigadier|authlib|commons|fastutil|adventure|jline|asm|snakeyaml|\?)/i;

/** Score plugin candidates from error context lines and stack frames (jar names, packages). */
export function findCulprit(text: string, findings: Finding[]): Diagnosis["culprit"] {
  const score = new Map<string, { name: string; s: number; reasons: string[] }>();
  const add = (p: string | undefined, s: number, reason: string) => {
    if (!p || NOT_PLUGIN.test(p)) return;
    const id = p.toLowerCase().replace(/[-_ ]?(\d[\w.+-]*)?$/, "") || p.toLowerCase();
    const e = score.get(id) ?? { name: p.replace(/-\d[\w.+-]*$/, ""), s: 0, reasons: [] };
    e.s += s;
    if (!e.reasons.includes(reason)) e.reasons.push(reason);
    score.set(id, e);
  };
  for (const f of findings) if (f.plugin) add(f.plugin, f.kind === "plugin_error" || f.kind === "missing_dependency" ? 8 : 5, `named in ${f.kind.replace(/_/g, " ")}`);
  const traceStart = text.search(/(?:Exception|Error)[:\s]/);
  const trace = traceStart >= 0 ? text.slice(traceStart, traceStart + 8000) : "";
  for (const m of trace.matchAll(/~\[([^\]:/\\]+?)\.jar:[^\]]*\]/g)) add(m[1], 2, "its jar is in the failing stack");
  const best = [...score.values()].sort((a, b) => b.s - a.s)[0];
  if (!best) return undefined;
  return { plugin: best.name, confidence: best.s >= 8 ? "high" : best.s >= 4 ? "medium" : "low", reasons: best.reasons };
}
