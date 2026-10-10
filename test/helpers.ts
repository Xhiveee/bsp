import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type BspConfig } from "../src/config.js";
import { createServices, type Services } from "../src/services.js";
import { HttpError, type Fetcher, type FetchResult } from "../src/util/http.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.join(here, "fixtures");
export const fixture = (name: string) => readFileSync(path.join(FIXTURES, name), "utf8");

/** URL → fixture file (captured from the live official endpoints, see test/fixtures/routes.json). Anything else is a 404. */
export function fixtureRoutes(): Record<string, string> {
  return JSON.parse(fixture("routes.json")) as Record<string, string>;
}

export class FixtureFetcher implements Fetcher {
  readonly requested: string[] = [];
  constructor(private readonly routes = fixtureRoutes()) {}
  async getText(url: string): Promise<FetchResult> {
    this.requested.push(url);
    const file = this.routes[url];
    if (!file) throw new HttpError(url, 404);
    return { body: fixture(file), source: "cache", fetchedAt: 0 };
  }
}

export function tmpDir(prefix = "bsp-test-"): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Services wired to fixtures and an isolated (empty) user-profile dir. */
export function fixtureServices(overrides: Partial<BspConfig> = {}): Services {
  const config: BspConfig = { ...loadConfig({}), userProfilesDir: tmpDir("bsp-userprofiles-"), cacheDir: tmpDir("bsp-cache-"), ...overrides };
  return createServices({ config, fetcher: new FixtureFetcher() });
}
