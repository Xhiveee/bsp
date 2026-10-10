import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { diagnose } from "../src/diagnostics/parse.js";
import { findingLine } from "../src/tools/crash.js";

const fx = (f: string) => readFileSync(path.join(__dirname, "fixtures", "logs", f), "utf8");
const compile = (text: string) => diagnose(text).findings.filter((f) => f.kind === "compile_error");

describe("compiler errors (shared by build and analyze_crash)", () => {
  it("Gradle 8.11+ output (Linux): duplicates from the failure summary merged, NMS hints", () => {
    const d = diagnose(fx("gradle-javac-linux.log"));
    expect(d.findings.some((f) => f.kind === "build_failure")).toBe(false);
    const errs = d.findings.filter((f) => f.kind === "compile_error");
    expect(errs).toHaveLength(6);
    const by = (re: RegExp) => errs.find((f) => re.test(f.message))!;
    expect(by(/v1_20_R3/).suggestion).toMatch(/Versioned package v1_20_R3.*nms_validate.*search_server_source query=CraftPlayer/);
    const ep = by(/EntityPlayer/);
    expect(ep).toMatchObject({ line: 8, message: "cannot find symbol: class EntityPlayer (in package net.minecraft.server.level) ×2", also: ["MyPlugin.java:25"] });
    expect(ep.suggestion).toMatch(/Spigot-mapped name; Mojang mappings call it ServerPlayer.*translate_mapping name=EntityPlayer from=spigot/);
    expect(by(/latency/).suggestion).toMatch(/get_class className=net\.minecraft\.server\.level\.ServerPlayer memberFilter=latency/);
    expect(by(/cannot be applied/).message).toBe("method sendMessage in interface CommandSender cannot be applied to given types (required: String; found: no arguments) — actual and formal argument lists differ in length");
    expect(by(/is not abstract/).suggestion).toMatch(/className=EventExecutor method=onEvent/);
    expect(by(/unreported exception IOException/).suggestion).toBeUndefined();
    expect(findingLine(ep)).toMatch(/\(also MyPlugin\.java:25\)\n  → .*ServerPlayer/);
  });

  it("Maven on Windows (CRLF, C:\\ paths, [line,col]) with the summary repeat deduped", () => {
    const d = diagnose(fx("maven-javac-windows.log"));
    expect(d.source).toBe("maven");
    expect(d.findings.some((f) => f.kind === "build_failure")).toBe(false);
    expect(compile(fx("maven-javac-windows.log")).map((f) => [f.file, f.line, f.message])).toEqual([
      ["C:\\dev\\myplugin\\src\\main\\java\\me\\alex\\MyPlugin.java", 14, "cannot find symbol: class EntityPlayer (in package net.minecraft.server.level) ×2"],
      ["/home/alex/myplugin/src/main/java/me/alex/Util.java", 8, "package org.bukkit.craftbukkit.v1_20_R3.entity does not exist"],
    ]);
  });

  it("localised javac (Russian, Windows, CRLF)", () => {
    const errs = compile(fx("gradle-javac-ru-windows.log"));
    expect(errs.map((f) => [f.line, f.message])).toEqual([
      [8, "cannot find symbol: class EntityPlayer (in package net.minecraft.server.level)"],
      [31, "cannot find symbol: method latency() (in variable handle of type net.minecraft.server.level.ServerPlayer)"],
    ]);
    expect(errs[0]!.file).toBe("C:\\Users\\Алексей\\plugins\\myplugin\\src\\main\\java\\me\\alex\\myplugin\\MyPlugin.java");
    expect(errs[1]!.suggestion).toMatch(/memberFilter=latency/);
  });

  it("obfuscated member names and Kotlin", () => {
    const [o] = compile("/p/A.java:3: error: cannot find symbol\n  symbol:   method b(int)\n  location: variable p of type net.minecraft.server.level.ServerPlayer\n");
    expect(o!.suggestion).toMatch(/obfuscated name.*translate_mapping name=net\.minecraft\.server\.level\.ServerPlayer#b from=obf/);
    const [k] = compile("e: file:///C:/dev/kp/src/main/kotlin/Main.kt:4:5 Unresolved reference 'EntityPlayer'.\n");
    expect(k).toMatchObject({ file: "C:/dev/kp/src/main/kotlin/Main.kt", line: 4, message: "Unresolved reference: EntityPlayer" });
    expect(k!.suggestion).toMatch(/Spigot-mapped/);
  });
});
