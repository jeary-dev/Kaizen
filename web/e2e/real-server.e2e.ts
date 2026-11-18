/**
 * Full round trip against a real Minecraft server and a running web app:
 *
 *   console `kaizen editor all` → browser opens the link, decrypts, edits, saves → console
 *   `kaizen apply CODE` → `kaizen confirm TOKEN` → files on disk, backups, secrets intact.
 *
 * Env: KAIZEN_E2E_SERVER (server folder with Kaizen installed), KAIZEN_E2E_WEB (web base URL,
 * default http://localhost:3100), KAIZEN_E2E_JAR (server jar name, default server.jar).
 * Run with `npm run e2e`.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deriveSessionKeys, sha256Hex } from "@/lib/protocol/crypto";
import { b64uDecode, utf8Decode } from "@/lib/protocol/encoding";
import { envelopeToJson, open, parseEnvelope, seal } from "@/lib/protocol/envelope";
import { type ChangesPayload, decodeUpload, encodePayload, type UploadPayload } from "@/lib/protocol/payload";

const serverDir = process.env.KAIZEN_E2E_SERVER ?? "";
const web = process.env.KAIZEN_E2E_WEB ?? "http://localhost:3100";
const jar = process.env.KAIZEN_E2E_JAR ?? "server.jar";

class Console {
  private out = "";
  private waiters: Array<() => void> = [];
  constructor(readonly proc: ChildProcessWithoutNullStreams) {
    const onData = (chunk: Buffer) => {
      // Strip ANSI colours so the patterns below stay simple.
      this.out += chunk.toString("utf8").replace(/\u001b\[[0-9;]*m/g, "");
      this.waiters.forEach((w) => w());
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
  }
  mark(): number {
    return this.out.length;
  }
  since(mark: number): string {
    return this.out.slice(mark);
  }
  run(command: string): number {
    const m = this.mark();
    this.proc.stdin.write(`${command}\n`);
    return m;
  }
  async waitFor(pattern: RegExp, from = 0, timeoutMs = 60_000): Promise<RegExpMatchArray> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const match = this.out.slice(from).match(pattern);
      if (match) return match;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${pattern}\n--- output ---\n${this.out.slice(from).slice(-4000)}`);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 250);
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
      this.waiters = [];
    }
  }
}

const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const backupsDir = () => join(serverDir, "plugins", "Kaizen", "backups");
const backups = () => (existsSync(backupsDir()) ? readdirSync(backupsDir()).filter((n) => !n.startsWith(".")) : []);

interface Opened {
  sid: string;
  key: Uint8Array;
  upload: UploadPayload;
  uploadSha: string;
  editToken: string;
}

async function openEditor(link: string): Promise<Opened> {
  const url = new URL(link);
  expect(url.origin).toBe(new URL(web).origin);
  const sid = url.pathname.split("/").pop() ?? "";
  const key = b64uDecode(new URLSearchParams(url.hash.slice(1)).get("k") ?? "", "k");
  const keys = await deriveSessionKeys(key, sid);
  const res = await fetch(`${web}/api/v1/sessions/${sid}`, { headers: { Authorization: `Bearer ${keys.editToken}` } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { envelope: unknown; status: string };
  expect(body.status).toBe("open");
  const plaintext = await open({ key: keys.up, expectedSid: sid, expectedKind: "upload", envelope: parseEnvelope(body.envelope) });
  return { sid, key, upload: decodeUpload(plaintext, sid), uploadSha: await sha256Hex(plaintext), editToken: keys.editToken };
}

async function save(o: Opened, rev: number, edits: Record<string, string>): Promise<string> {
  const keys = await deriveSessionKeys(o.key as Uint8Array<ArrayBuffer>, o.sid);
  const payload: ChangesPayload = {
    format: "kaizen.changes",
    v: 1,
    sid: o.sid,
    uploadSha256: o.uploadSha,
    createdAt: new Date().toISOString(),
    files: Object.entries(edits).map(([path, content]) => {
      const file = o.upload.files.find((f) => f.path === path);
      if (!file) throw new Error(`not in upload: ${path}`);
      return { path, baseSha256: file.sha256, content };
    }),
  };
  const envelope = await seal({ key: keys.down, kind: "changes", sid: o.sid, rev, plaintext: encodePayload(payload) });
  const res = await fetch(`${web}/api/v1/sessions/${o.sid}/changes`, {
    method: "POST",
    headers: { Authorization: `Bearer ${keys.editToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ envelope: envelopeToJson(envelope) }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { code: string }).code;
}

const file = (o: Opened, path: string) => {
  const f = o.upload.files.find((x) => x.path === path);
  if (!f) throw new Error(`${path} missing from upload; have ${o.upload.files.map((x) => x.path).join(", ")}`);
  return f;
};

const ORIGINAL_CONFIG =
  '# ShopDemo settings\nshop:\n  title: "Sakura Market"\n  max-items: 27\n\ndatabase:\n  host: db.internal\n  password: "hunter2-very-secret"\n';
const ORIGINAL_PROPS = "motd=hello\r\napi-key=sk_live_abcdef1234567890\r\n";

describe.skipIf(!serverDir)("real server", () => {
  let mc: Console;

  beforeAll(async () => {
    const health = await fetch(`${web}/api/v1/health`).catch(() => null);
    if (!health?.ok) throw new Error(`the web app is not running at ${web}`);
    // Fresh fixtures every run: a fake plugin with one YAML secret and one CRLF properties secret.
    const shop = join(serverDir, "plugins", "ShopDemo");
    mkdirSync(shop, { recursive: true });
    writeFileSync(join(shop, "config.yml"), ORIGINAL_CONFIG);
    writeFileSync(join(shop, "extra.properties"), ORIGINAL_PROPS);
    const proc = spawn("java", ["-Xmx2G", "-Dstdout.encoding=UTF-8", "-Dstderr.encoding=UTF-8", "-jar", jar, "--nogui"], { cwd: serverDir, stdio: "pipe" });
    mc = new Console(proc);
    await mc.waitFor(/Kaizen 1\.\d+\.\d+ ready/, 0, 180_000);
    await mc.waitFor(/Done \(\d/, 0, 180_000);
  }, 200_000);

  afterAll(async () => {
    if (!mc) return;
    const exited = new Promise((resolve) => mc.proc.once("exit", resolve));
    mc.run("stop");
    await Promise.race([exited, new Promise((r) => setTimeout(r, 60_000))]);
    if (mc.proc.exitCode === null) mc.proc.kill();
  }, 70_000);

  it("edits, applies and protects secrets end to end", async () => {
    const configPath = join(serverDir, "plugins", "ShopDemo", "config.yml");
    const propsPath = join(serverDir, "plugins", "ShopDemo", "extra.properties");
    const originalProps = readFileSync(propsPath);
    const backupsBefore = backups().length;

    // 1. Open the editor from the console.
    let m = mc.run("kaizen editor all");
    const link = (await mc.waitFor(/(https?:\/\/\S+\/e\/[A-Za-z0-9_-]{22}#k=[A-Za-z0-9_-]{43})/, m))[1];
    await mc.waitFor(/secret value\(s\) locked/, m);
    const o = await openEditor(link);

    // 2. The upload holds placeholders, never the secrets themselves.
    const cfg = file(o, "plugins/ShopDemo/config.yml");
    const props = file(o, "plugins/ShopDemo/extra.properties");
    const all = o.upload.files.map((f) => f.content).join("\n");
    expect(all).not.toContain("hunter2-very-secret");
    expect(all).not.toContain("sk_live_abcdef1234567890");
    expect(cfg.secrets.map((s) => s.key)).toContain("database.password");
    expect(props.secrets.map((s) => s.key)).toContain("api-key");
    expect(props.content).toContain("\r\n"); // line endings survive the trip
    expect(o.upload.files.some((f) => f.path.startsWith("plugins/Kaizen/"))).toBe(false);
    expect(cfg.plugin).toBe("ShopDemo");

    // 3. Edit like the browser would: change a value, keep the locked placeholder as it is.
    const editedCfg = cfg.content.replace('title: "Sakura Market"', 'title: "Hanami Market"').replace("max-items: 27", "max-items: 54");
    const editedProps = props.content.replace("motd=hello", "motd=konnichiwa");
    await save(o, 1, { [cfg.path]: cfg.content.replace("max-items: 27", "max-items: 36") });
    const code = await save(o, 2, { [cfg.path]: editedCfg, [props.path]: editedProps }); // a later save replaces the first

    // 4. Apply from the console, with lowercase and a dash to exercise normalisation.
    m = mc.run(`kaizen apply ${code.slice(0, 4).toLowerCase()}-${code.slice(4)}`);
    await mc.waitFor(/Ready to apply changes to 2 file\(s\)/, m);
    const token = (await mc.waitFor(/kaizen confirm ([A-Za-z0-9]+)/, m))[1];
    expect(sha(configPath)).toBe(cfg.sha256); // nothing written before confirming

    m = mc.run(`kaizen confirm ${token}`);
    await mc.waitFor(/Applied changes to 2 file\(s\)/, m);
    await mc.waitFor(/ShopDemo.*reload it with its own command/, m);

    // 5. Disk: edits applied, real secrets restored, formatting and line endings kept.
    const written = readFileSync(configPath, "utf8");
    expect(written).toContain('title: "Hanami Market"');
    expect(written).toContain("max-items: 54");
    expect(written).toContain('password: "hunter2-very-secret"');
    expect(written).toContain("# ShopDemo settings");
    expect(written).not.toContain("KAIZEN_SECRET");
    expect(readFileSync(propsPath, "latin1")).toBe("motd=konnichiwa\r\napi-key=sk_live_abcdef1234567890\r\n");

    // 6. A backup of the originals exists.
    expect(backups().length).toBe(backupsBefore + 1);
    const newest = backups().sort().pop() ?? "";
    const backedUp = readdirSync(join(backupsDir(), newest), { recursive: true }).map(String);
    expect(backedUp.some((p) => p.endsWith("extra.properties"))).toBe(true);
    const originalBackup = backedUp.find((p) => p.endsWith("extra.properties")) ?? "";
    expect(readFileSync(join(backupsDir(), newest, originalBackup))).toEqual(originalProps);

    // 7. The code works once; the session is closed.
    m = mc.run(`kaizen apply ${code}`);
    await mc.waitFor(/Nothing was applied/, m);
    const after = await fetch(`${web}/api/v1/sessions/${o.sid}`, { headers: { Authorization: `Bearer ${o.editToken}` } });
    expect(((await after.json()) as { status: string }).status).toBe("applied");
  }, 120_000);

  it("rejects tampered changes and unknown codes without touching disk", async () => {
    const configPath = join(serverDir, "plugins", "ShopDemo", "config.yml");
    const before = sha(configPath);

    let m = mc.run("kaizen apply ZZZZZZZZ");
    await mc.waitFor(/Nothing was applied/, m);

    // Wait out the 10 s editor cooldown from the previous test.
    await new Promise((r) => setTimeout(r, 10_500));
    m = mc.run("kaizen editor ShopDemo");
    const link = (await mc.waitFor(/(https?:\/\/\S+\/e\/[A-Za-z0-9_-]{22}#k=[A-Za-z0-9_-]{43})/, m))[1];
    const o = await openEditor(link);
    expect(o.upload.files.every((f) => f.plugin === "ShopDemo")).toBe(true);

    // A changes envelope sealed with the wrong key (e.g. by someone who only knows the edit token).
    const cfg = file(o, "plugins/ShopDemo/config.yml");
    const wrong = { ...o, key: new Uint8Array(32).fill(7) };
    const keys = await deriveSessionKeys(o.key as Uint8Array<ArrayBuffer>, o.sid);
    const forged = await deriveSessionKeys(wrong.key as Uint8Array<ArrayBuffer>, o.sid);
    const payload = encodePayload({
      format: "kaizen.changes",
      v: 1,
      sid: o.sid,
      uploadSha256: o.uploadSha,
      createdAt: new Date().toISOString(),
      files: [{ path: cfg.path, baseSha256: cfg.sha256, content: cfg.content + "\nevil: true\n" }],
    });
    const envelope = await seal({ key: forged.down, kind: "changes", sid: o.sid, rev: 1, plaintext: payload });
    const res = await fetch(`${web}/api/v1/sessions/${o.sid}/changes`, {
      method: "POST",
      headers: { Authorization: `Bearer ${keys.editToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ envelope: envelopeToJson(envelope) }),
    });
    const { code } = (await res.json()) as { code: string };

    m = mc.run(`kaizen apply ${code}`);
    const failure = await mc.waitFor(/Nothing was applied: ([^\n]+)/, m);
    expect(failure[1]).toMatch(/failed verification/);
    expect(sha(configPath)).toBe(before);
    expect(utf8Decode(readFileSync(configPath))).not.toContain("evil");
  }, 90_000);

  it("lists history and undoes the apply exactly, then redoes it", async () => {
    const configPath = join(serverDir, "plugins", "ShopDemo", "config.yml");
    const propsPath = join(serverDir, "plugins", "ShopDemo", "extra.properties");
    const applied = readFileSync(configPath);

    let m = mc.run("kaizen history");
    await mc.waitFor(/Recent changes/, m);
    const id = (await mc.waitFor(/• (\d{8}-\d{6}-[a-z0-9]{4}) [^\n]*apply by console · 2 file\(s\)/, m))[1];

    // Cancelling changes nothing.
    m = mc.run("kaizen undo");
    let token = (await mc.waitFor(/kaizen confirm ([A-Za-z0-9]+)/, m))[1];
    m = mc.run(`kaizen cancel ${token}`);
    await mc.waitFor(/Cancelled\. Nothing was changed\./, m);
    expect(readFileSync(configPath)).toEqual(applied);

    m = mc.run("kaizen undo");
    await mc.waitFor(new RegExp(`Undo ${id}\\? This restores 2 file\\(s\\)`), m);
    token = (await mc.waitFor(/kaizen confirm ([A-Za-z0-9]+)/, m))[1];
    m = mc.run(`kaizen confirm ${token}`);
    await mc.waitFor(new RegExp(`Restored the files from ${id}`), m);
    expect(readFileSync(configPath, "utf8")).toBe(ORIGINAL_CONFIG);
    expect(readFileSync(propsPath, "latin1")).toBe(ORIGINAL_PROPS);

    // The undo is in the history and can itself be undone.
    m = mc.run("kaizen history");
    await mc.waitFor(/undo by console · 2 file\(s\)/, m);
    m = mc.run("kaizen undo");
    token = (await mc.waitFor(/kaizen confirm ([A-Za-z0-9]+)/, m))[1];
    m = mc.run(`kaizen confirm ${token}`);
    await mc.waitFor(/Restored the files from/, m);
    expect(readFileSync(configPath)).toEqual(applied);

    // Unknown ids and bad input are explained.
    m = mc.run("kaizen undo 20200101-000000-zzzz");
    await mc.waitFor(/There is no backup called 20200101-000000-zzzz/, m);
  }, 90_000);
});
