import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { spawnPlan, winCmdLine } from "../src/exec/run.js";
import { buildToolsArgs, buildToolsOutputs, buildToolsPathProblem, javaBin, pickBuildToolsJdk } from "../src/index/buildtools.js";
import { candidateRoots } from "../src/jdk/discover.js";
import type { JdkInfo } from "../src/jdk/discover.js";
import { gradleWrapper, mavenCandidates } from "../src/tools/build.js";

const jdk = (major: number, home = `C:\\Program Files\\Eclipse Adoptium\\jdk-${major}`): JdkInfo => ({ home, major, isJdk: true }) as JdkInfo;

describe("Windows (simulated)", () => {
  it("wrappers and launchers", () => {
    expect(gradleWrapper("C:\\dev\\my plugin", "win32")).toBe("C:\\dev\\my plugin\\gradlew.bat");
    expect(javaBin("C:\\Program Files\\Java\\jdk-21", "win32")).toBe("C:\\Program Files\\Java\\jdk-21\\bin\\java.exe");
    expect(javaBin("/usr/lib/jvm/java-21", "linux")).toBe("/usr/lib/jvm/java-21/bin/java");
    expect(mavenCandidates("C:\\dev\\p", 'C:\\Windows;"C:\\Program Files\\Maven\\bin";;C:\\tools', "win32")).toEqual([
      "C:\\dev\\p\\mvnw.cmd",
      "C:\\Windows\\mvn.cmd",
      "C:\\Program Files\\Maven\\bin\\mvn.cmd",
      "C:\\tools\\mvn.cmd",
    ]);
    expect(mavenCandidates("/p", "/usr/bin:/opt/mvn/bin", "linux")).toEqual(["/p/mvnw", "/usr/bin/mvn", "/opt/mvn/bin/mvn"]);
  });

  it(".cmd/.bat go through cmd.exe with quoting; .exe is spawned directly", () => {
    const p = spawnPlan("C:\\dev\\my plugin\\mvnw.cmd", ["package", "-B", "-Dx=a b"], "win32", "C:\\Windows\\system32\\cmd.exe");
    expect(p).toEqual({
      file: "C:\\Windows\\system32\\cmd.exe",
      args: ["/d", "/s", "/c", '""C:\\dev\\my plugin\\mvnw.cmd" package -B "-Dx=a b""'],
      verbatim: true,
    });
    expect(spawnPlan("C:\\jdk\\bin\\java.exe", ["-jar", "C:\\a b\\BuildTools.jar"], "win32")).toEqual({ file: "C:\\jdk\\bin\\java.exe", args: ["-jar", "C:\\a b\\BuildTools.jar"], verbatim: false });
    expect(spawnPlan("/p/gradlew", ["build"], "linux").verbatim).toBe(false);
    expect(winCmdLine("x.bat", ['say "hi"', "a&b", ""])).toBe('x.bat "say ""hi""" "a&b" ""');
  });

  it("BuildTools paths, JDK choice and arguments", () => {
    expect(buildToolsPathProblem("C:\\Users\\Иван\\AppData\\Local\\bsp\\buildtools", "win32")).toMatch(/non-ASCII/);
    expect(buildToolsPathProblem("C:\\Users\\John Smith\\AppData\\Local\\bsp\\buildtools", "win32")).toMatch(/spaces/);
    expect(buildToolsPathProblem("C:\\bsp!\\buildtools", "win32")).toMatch(/!/);
    expect(buildToolsPathProblem(`C:\\${"x".repeat(120)}`, "win32")).toMatch(/MAX_PATH/);
    expect(buildToolsPathProblem(`/home/u/${"x".repeat(120)}`, "linux")).toBeUndefined();
    expect(buildToolsPathProblem("C:\\Users\\john\\AppData\\Local\\bsp\\buildtools", "win32")).toBeUndefined();
    // 1.13.2 declares class files 52–55 → Java 8–11; 25 is too new, 11 newest fitting
    expect(pickBuildToolsJdk([jdk(8), jdk(11), jdk(25)], [52, 55])?.major).toBe(11);
    expect(pickBuildToolsJdk([jdk(17)], [52, 55])).toBeUndefined();
    expect(pickBuildToolsJdk([jdk(17), jdk(21)])?.major).toBe(21);
    expect(buildToolsArgs("C:\\c\\BuildTools.jar", "1.20.4", "C:\\c\\out\\1.20.4", true)).toEqual(["-jar", "C:\\c\\BuildTools.jar", "--rev", "1.20.4", "--output-dir", "C:\\c\\out\\1.20.4", "--nogui", "--remapped"]);
  });

  it("finds BuildTools outputs, skipping sources/javadoc jars", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "bsp-bt-"));
    const out = path.join(root, "out", "1.13.2");
    mkdirSync(out, { recursive: true });
    for (const f of ["spigot-1.13.2.jar", "spigot-1.13.2-sources.jar", "craftbukkit-1.13.2.jar", "spigot-1.13.20.txt"]) writeFileSync(path.join(out, f), "");
    expect(buildToolsOutputs(root, "1.13.2").map((f) => path.basename(f))).toEqual(["spigot-1.13.2.jar"]);
  });

  it("JDK search roots on Windows", () => {
    const roots = candidateRoots({ JAVA_HOME: "C:\\jdk21", BSP_JDKS: "D:\\jdks;E:\\java\\jdk8", ProgramFiles: "C:\\Program Files", LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, "win32", "C:\\Users\\u");
    const dirs = roots.map((r) => r.dir);
    expect(dirs.slice(0, 4)).toEqual(["D:\\jdks", "D:\\jdks", "E:\\java\\jdk8", "E:\\java\\jdk8"]);
    expect(dirs).toContain("C:\\jdk21");
    expect(dirs).toContain("C:\\Program Files\\Eclipse Adoptium");
    expect(dirs).toContain("C:\\Users\\u\\.gradle\\jdks");
    expect(dirs).toContain("C:\\Users\\u\\AppData\\Local\\Programs\\Eclipse Adoptium");
    expect(dirs.some((d) => d.includes("/"))).toBe(false);
  });
});
