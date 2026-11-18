/**
 * The editor in a real browser against a running web app (production build):
 *
 * - /demo renders under the strict CSP with no violations or console errors, secrets are locked,
 *   and review → save produces an apply code.
 * - A real session: this test plays the plugin (creates an encrypted upload, later claims and
 *   decrypts the changes) and drives the browser through the fragment link in between.
 *
 * Env: KAIZEN_E2E_WEB (default http://localhost:3100), KAIZEN_E2E_BROWSER (Chrome/Edge binary;
 * found automatically on Windows, macOS and Linux), KAIZEN_E2E_SHOTS (folder for screenshots).
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Browser, chromium, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deriveRawKeys, deriveSessionKeys, ownerHash, randomBytes, sha256Hex } from "@/lib/protocol/crypto";
import { b64uEncode, utf8Encode } from "@/lib/protocol/encoding";
import { envelopeToJson, open, parseEnvelope, seal } from "@/lib/protocol/envelope";
import { decodeChanges, encodePayload, type UploadPayload } from "@/lib/protocol/payload";

const web = process.env.KAIZEN_E2E_WEB ?? "http://localhost:3100";
const shots = process.env.KAIZEN_E2E_SHOTS;
const browserPath =
  process.env.KAIZEN_E2E_BROWSER ??
  [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].find((p) => existsSync(p));

interface Watch {
  problems: string[];
}

async function newPage(browser: Browser, viewport = { width: 1440, height: 900 }): Promise<{ page: Page; watch: Watch }> {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const watch: Watch = { problems: [] };
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => {
      console.error(`CSP violation: ${e.violatedDirective} blocked ${e.blockedURI || "inline"}`);
    });
  });
  page.on("console", (m) => {
    if (m.type() === "error") watch.problems.push(m.text());
  });
  page.on("pageerror", (e) => watch.problems.push(`page error: ${e.message}`));
  page.on("requestfailed", (r) => watch.problems.push(`request failed: ${r.url()}`));
  page.on("request", (r) => {
    if (!r.url().startsWith(web)) watch.problems.push(`third-party request: ${r.url()}`);
  });
  return { page, watch };
}

async function shot(page: Page, name: string) {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: join(shots, `${name}.png`) });
}

/** Puts the cursor at the end of the first line containing [text]. */
async function endOfLine(page: Page, text: string) {
  await page.locator(".cm-content .cm-line", { hasText: text }).first().click();
  await page.keyboard.press("End");
}

describe.skipIf(!browserPath)("editor in a browser", () => {
  let browser: Browser;

  beforeAll(async () => {
    const health = await fetch(`${web}/api/v1/health`).catch(() => null);
    if (!health?.ok) throw new Error(`the web app is not running at ${web}`);
    browser = await chromium.launch({ executablePath: browserPath, headless: true });
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
  });

  it("demo: renders under the CSP, locks secrets, reviews and saves", async () => {
    const { page, watch } = await newPage(browser);
    const response = await page.goto(`${web}/demo`);
    expect(response?.headers()["content-security-policy"]).toMatch(/script-src 'self' 'nonce-/);
    await page.locator(".cm-content").waitFor();
    await expect.poll(() => page.locator(".cm-kz-secret").count()).toBe(2);
    await shot(page, "demo-desktop");

    // Typing right after a locked secret would change its id, so the editor refuses it.
    await endOfLine(page, "password:");
    await page.keyboard.type("x");
    expect(await page.locator(".cm-line", { hasText: "password:" }).textContent()).toBe("  password: locked");

    // A YAML mistake shows up as a problem, and undo takes it away.
    await endOfLine(page, "tax-percent:");
    await page.keyboard.press("Enter");
    await page.keyboard.type("nested: a: b"); // not valid YAML (brackets would be auto-closed)
    await expect.poll(() => page.locator("footer").innerText(), { timeout: 3000 }).toMatch(/1 error/);
    await shot(page, "demo-error");
    for (let i = 0; i < 4 && (await page.locator(".cm-line", { hasText: "nested" }).count()) > 0; i++) await page.keyboard.press("Control+z");
    await expect.poll(() => page.locator("footer").innerText(), { timeout: 3000 }).toMatch(/No problems/);

    // A normal edit.
    await endOfLine(page, "rows:");
    await page.keyboard.press("Backspace");
    await page.keyboard.type("5");
    await expect.poll(() => page.locator('nav button[aria-current="true"] [aria-label="changed"]').count()).toBe(1);

    // Review and save.
    await page.keyboard.press("Control+s");
    const dialog = page.getByRole("dialog", { name: "Review changes" });
    await dialog.waitFor();
    await expect.poll(() => dialog.locator(".cm-mergeView").count()).toBe(1);
    await shot(page, "demo-review");
    await dialog.getByRole("button", { name: "Save & get apply code" }).click();
    const code = await page.getByLabel(/^Apply code/).innerText();
    expect(code).toMatch(/^[0-9A-Z]{4} [0-9A-Z]{4}$/);
    await shot(page, "demo-saved");

    expect(watch.problems).toEqual([]);
  }, 60_000);

  it("demo: usable on a tablet and a phone", async () => {
    for (const [name, viewport] of [
      ["tablet", { width: 820, height: 1180 }],
      ["phone", { width: 390, height: 844 }],
    ] as const) {
      const { page, watch } = await newPage(browser, viewport);
      await page.goto(`${web}/demo`);
      await page.locator(".cm-content").waitFor();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `${name} scrolls sideways`).toBeLessThanOrEqual(0);
      await shot(page, `demo-${name}`);
      await page.getByRole("button", { name: "Show files" }).click();
      await page.getByRole("button", { name: /waystones\.json/ }).click();
      await expect.poll(() => page.getByRole("list", { name: "Open files" }).getByRole("button", { name: "waystones.json", exact: true }).count()).toBe(1);
      await expect.poll(() => page.locator("#kz-sidebar").boundingBox().then((b) => (b ? b.x + b.width : 0))).toBeLessThanOrEqual(0);
      await shot(page, `demo-${name}-json`);
      expect(watch.problems).toEqual([]);
    }
  }, 60_000);

  it("real session: browser edits round-trip byte for byte to the plugin", async () => {
    // --- as the plugin -----------------------------------------------------------------------
    const key = randomBytes(32);
    const sid = b64uEncode(randomBytes(16));
    const owner = randomBytes(32);
    const props = "#Minecraft server properties\r\nmotd=hi\r\nrcon.password=KAIZEN_SECRET_1_t3st\r\n";
    const yaml = "bloom: true\npetals: 128\n";
    const upload: UploadPayload = {
      format: "kaizen.upload",
      v: 1,
      sid,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      server: { software: "Paper 1.21.11", kaizen: "1.0.0" },
      scope: "all",
      files: [
        { path: "server.properties", plugin: null, lang: "properties", sha256: await sha256Hex(utf8Encode(props)), content: props, secrets: [{ id: "KAIZEN_SECRET_1_t3st", key: "rcon.password", line: 3 }] },
        { path: "plugins/Sakura/config.yml", plugin: "Sakura", lang: "yaml", sha256: await sha256Hex(utf8Encode(yaml)), content: yaml, secrets: [] },
      ],
      reloadHints: {},
    };
    const plaintext = encodePayload(upload);
    const raw = await deriveRawKeys(key, sid);
    const upKey = await crypto.subtle.importKey("raw", raw.up, "AES-GCM", false, ["encrypt"]);
    const keys = await deriveSessionKeys(key, sid);
    const created = await fetch(`${web}/api/v1/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        envelope: envelopeToJson(await seal({ key: upKey, kind: "upload", sid, rev: 0, plaintext })),
        ownerHash: await ownerHash(owner, sid),
        editHash: keys.editHash,
        ttlSeconds: 600,
      }),
    });
    expect(created.status).toBe(201);

    // --- as the admin in the browser -----------------------------------------------------------
    const { page, watch } = await newPage(browser);
    const apiCalls: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/")) apiCalls.push(r.url());
    });
    await page.goto(`${web}/e/${sid}#k=${b64uEncode(key)}`);
    await page.getByRole("heading", { name: "Pick a file to start" }).waitFor();

    await page.getByRole("button", { name: /config\.yml/ }).click();
    await endOfLine(page, "petals:");
    for (let i = 0; i < 3; i++) await page.keyboard.press("Backspace");
    await page.keyboard.type("256");

    await page.getByRole("button", { name: /server\.properties/ }).click();
    await expect.poll(() => page.locator("footer").innerText()).toMatch(/CRLF/);
    await endOfLine(page, "motd=");
    await page.keyboard.type("gh tide");

    await page.getByRole("button", { name: /Review changes/ }).click();
    const dialog = page.getByRole("dialog", { name: "Review changes" });
    await expect.poll(() => dialog.locator("header").innerText()).toMatch(/2 files/);
    await dialog.getByRole("button", { name: "Save & get apply code" }).click();
    const code = (await page.getByLabel(/^Apply code/).innerText()).replace(" ", "");

    // The key never left the browser: no request carried the fragment.
    expect(apiCalls.every((u) => !u.includes(b64uEncode(key)))).toBe(true);
    expect(watch.problems).toEqual([]);

    // --- as the plugin again -------------------------------------------------------------------
    const claim = await fetch(`${web}/api/v1/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${b64uEncode(owner)}` },
      body: JSON.stringify({ code }),
    });
    expect(claim.status).toBe(200);
    const { envelope } = (await claim.json()) as { envelope: unknown };
    const downKey = await crypto.subtle.importKey("raw", raw.down, "AES-GCM", false, ["decrypt"]);
    const changes = decodeChanges(await open({ key: downKey, expectedSid: sid, expectedKind: "changes", envelope: parseEnvelope(envelope) }), sid);
    const byPath = Object.fromEntries(changes.files.map((f) => [f.path, f.content]));
    expect(byPath).toEqual({
      "plugins/Sakura/config.yml": "bloom: true\npetals: 256\n",
      "server.properties": "#Minecraft server properties\r\nmotd=high tide\r\nrcon.password=KAIZEN_SECRET_1_t3st\r\n",
    });
    expect(changes.uploadSha256).toBe(await sha256Hex(plaintext));
  }, 60_000);

  it("landing, privacy and 404 pages are CSP-clean and fit a phone", async () => {
    for (const [name, viewport] of [
      ["desktop", { width: 1440, height: 900 }],
      ["phone", { width: 390, height: 844 }],
    ] as const) {
      const { page, watch } = await newPage(browser, viewport);
      for (const [path, heading] of [
        ["/", /Edit plugin configs in your browser/],
        ["/privacy", /^Privacy$/],
        ["/nope", /This page doesn.t exist/],
      ] as const) {
        const res = await page.goto(`${web}${path}`);
        expect(res?.status()).toBe(path === "/nope" ? 404 : 200);
        await page.getByRole("heading", { level: 1, name: heading }).waitFor();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow, `${path} on ${name} scrolls sideways`).toBeLessThanOrEqual(0);
        await page.screenshot({ path: shots ? join(shots, `site-${path === "/" ? "home" : path.slice(1)}-${name}.png`) : undefined, fullPage: true });
      }
      expect(watch.problems.filter((p) => !p.includes("404"))).toEqual([]);
    }
  }, 60_000);

  it("explains broken and expired links", async () => {
    const { page } = await newPage(browser);
    await page.goto(`${web}/e/${"A".repeat(22)}`);
    await page.getByRole("heading", { name: "Incomplete link" }).waitFor();
    await page.goto(`${web}/e/${"A".repeat(22)}#k=${b64uEncode(randomBytes(32))}`);
    await page.reload();
    await page.getByRole("heading", { name: "Session not found" }).waitFor();
  }, 30_000);
});
