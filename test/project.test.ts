import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseMarkdown } from "../src/docs/search.js";
import { readProjectInfo } from "../src/project/info.js";
import { TOOLS } from "../src/tools/registry.js";

async function project(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bsp-proj-"));
  for (const [f, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, f)), { recursive: true });
    await writeFile(path.join(dir, f), text);
  }
  return dir;
}

describe("project detection", () => {
  it("Gradle paperweight", async () => {
    const dir = await project({
      "settings.gradle.kts": 'rootProject.name = "t"',
      "build.gradle.kts": 'plugins { id("io.papermc.paperweight.userdev") version "2.0.0-beta.24" }\ndependencies { paperweight.paperDevBundle("1.21.11-R0.1-SNAPSHOT") }',
      "src/main/resources/plugin.yml": "name: T\nmain: a.T\nversion: 1\napi-version: '1.21.11'\n",
    });
    const p = await readProjectInfo(dir);
    expect(p).toMatchObject({ build: "gradle", platform: "paper", mcVersion: "1.21.11", nms: "paperweight", devMappings: "mojang" });
    expect(p.pluginYml?.apiVersion).toBe("1.21.11");
  });
  it("Maven spigot-api + system-scope server jar", async () => {
    const dir = await project({
      "pom.xml": `<project><dependencies>
  <dependency><groupId>org.spigotmc</groupId><artifactId>spigot-api</artifactId><version>1.16.5-R0.1-SNAPSHOT</version><scope>provided</scope></dependency>
  <dependency><groupId>x</groupId><artifactId>lib</artifactId><version>1</version><scope>system</scope><systemPath>\${project.basedir}/libs/brigadier.jar</systemPath></dependency>
  <dependency><groupId>x</groupId><artifactId>srv</artifactId><version>1</version><scope>system</scope><systemPath>\${project.basedir}/libs/patched_1.16.5.jar</systemPath></dependency>
</dependencies></project>`,
    });
    const p = await readProjectInfo(dir);
    expect(p).toMatchObject({ build: "maven", platform: "spigot", mcVersion: "1.16.5", nms: "server-file" });
    expect(p.serverJar).toBe(path.join(dir, "libs/patched_1.16.5.jar"));
  });
  it("Maven remapped-mojang Spigot", async () => {
    const dir = await project({
      "pom.xml": `<project><dependencies><dependency><groupId>org.spigotmc</groupId><artifactId>spigot</artifactId><version>1.20.4-R0.1-SNAPSHOT</version><classifier>remapped-mojang</classifier></dependency></dependencies></project>`,
    });
    expect(await readProjectInfo(dir)).toMatchObject({ nms: "spigot-remapped", devMappings: "mojang", mcVersion: "1.20.4" });
  });
});

describe("docs", () => {
  it("parseMarkdown reads frontmatter slug and sections", () => {
    const r = parseMarkdown("---\ntitle: Userdev\nslug: paper/dev/userdev\n---\n\nIntro \\{x\\}\n\n## Setup\n\nText");
    expect(r.slug).toBe("paper/dev/userdev");
    expect(r.frontTitle ?? r.title).toBe("Userdev");
    expect(r.sections.some((s) => /Setup/.test(JSON.stringify(s)))).toBe(true);
  });
});

describe("registry", () => {
  it("has exactly the 9 tools", () => {
    expect(TOOLS.map((t) => t.name)).toEqual(["list_versions", "get_profile", "search_server_source", "get_class", "translate_mapping", "nms_validate", "docs_search", "build", "analyze_crash"]);
    expect(TOOLS.filter((t) => t.readOnly === false).map((t) => t.name)).toEqual(["build"]);
  });
});
