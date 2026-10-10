import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { diagnose } from "../src/diagnostics/parse.js";

const log = (n: string) => readFileSync(new URL(`./fixtures/logs/${n}.log`, import.meta.url), "utf8");

describe("diagnose", () => {
  it("NMS mismatch: one finding per class, culprit, server info", () => {
    const d = diagnose(log("nms-mismatch"));
    expect(d.server).toMatchObject({ software: "Paper", mc: "1.20.4" });
    expect(d.findings.filter((f) => f.kind === "nms_mismatch")).toHaveLength(1);
    expect(d.culprit?.plugin).toBe("BspTest");
  });
  it("plugin loading problems, no single culprit for independent failures", () => {
    const d = diagnose(log("plugin-load"));
    const kinds = d.findings.map((f) => f.kind);
    expect(kinds).toEqual(expect.arrayContaining(["api_version", "missing_dependency", "plugin_error", "nms_mismatch"]));
    expect(kinds.filter((k) => k === "missing_dependency")).toHaveLength(1);
    expect(d.culprit).toBeUndefined();
    expect(d.server?.mc).toBe("1.21.11");
  });
  it("EULA is never accepted on the user's behalf", () => {
    const d = diagnose(log("eula"));
    expect(d.findings[0]?.kind).toBe("eula");
    expect(d.findings[0]?.suggestion).toMatch(/never on their behalf/);
  });
  it("javac errors from Maven and Gradle", () => {
    const mvn = diagnose("[ERROR] /p/src/main/java/a/B.java:[12,9] cannot find symbol\n  symbol:   method latency()\n  location: class ServerPlayer\n[INFO] BUILD FAILURE");
    expect(mvn.findings[0]).toMatchObject({ kind: "compile_error", line: 12 });
    const gr = diagnose("/p/src/main/java/a/B.java:5: error: package org.bukkit.craftbukkit.entity does not exist\nimport org.bukkit.craftbukkit.entity.CraftPlayer;\n\n* What went wrong:\nExecution failed for task ':compileJava'.");
    expect(gr.findings.some((f) => f.kind === "compile_error" && f.line === 5)).toBe(true);
  });
  it("Gradle too old for a plugin variant", () => {
    const d = diagnose(`* What went wrong:
An exception occurred applying plugin request [id: 'io.papermc.paperweight.userdev', version: '2.0.0-beta.24']
> Failed to resolve plugin
   > No matching variant of io.papermc.paperweight:paperweight-userdev:2.0.0-beta.24 was found. The consumer was configured to find a library for use during runtime, compatible with Java 21, packaged as a jar, and its dependencies declared externally, as well as attribute 'org.gradle.plugin.api-version' with value '8.14.5' but:
       - Variant 'apiElements' declares a library for use during compile-time, compatible with Java 21, packaged as a jar, and its dependencies declared externally:
           - Incompatible because this component declares a component, as well as attribute 'org.gradle.plugin.api-version' with value '9.7.1' and the consumer needed a component, as well as attribute 'org.gradle.plugin.api-version' with value '8.14.5'`);
    expect(d.findings.map((f) => f.message).join("\n")).toMatch(/needs Gradle 9\.7\.1\+/);
  });
});
