import type { SavedChanges, SessionSource, LoadedSession } from "@/lib/editor/session";
import { sha256Hex } from "@/lib/protocol/crypto";
import { utf8Encode } from "@/lib/protocol/encoding";
import { APPLY_CODE_ALPHABET } from "@/lib/protocol/formats";
import type { ChangedFile, UploadFile, UploadPayload } from "@/lib/protocol/payload";

/**
 * The demo: the real editor with made-up configs, held in this tab only. Nothing is sent
 * anywhere. Saving returns a code that only shows what the flow looks like.
 */

const TAG = "demo";

const files: Omit<UploadFile, "sha256">[] = [
  {
    path: "server.properties",
    plugin: null,
    lang: "properties",
    content: [
      "#Minecraft server properties",
      "motd=\\u00A7dSakura SMP \\u00A77\\u00B7 spring season",
      "max-players=40",
      "view-distance=10",
      "simulation-distance=8",
      "difficulty=normal",
      "pvp=true",
      "white-list=false",
      "enable-rcon=true",
      "rcon.port=25575",
      "rcon.password=KAIZEN_SECRET_1_demo",
      "spawn-protection=16",
      "",
    ].join("\r\n"),
    secrets: [{ id: "KAIZEN_SECRET_1_demo", key: "rcon.password", line: 11 }],
  },
  {
    path: "plugins/SakuraShop/config.yml",
    plugin: "SakuraShop",
    lang: "yaml",
    content: `# SakuraShop: a small player market.
# Prices are in the server's main currency.

shop:
  title: "<#d9668a>Sakura Market"
  rows: 6
  open-on-join: false
  tax-percent: 2.5

categories:
  blocks:
    icon: CHERRY_LOG
    slot: 11
  tools:
    icon: DIAMOND_PICKAXE
    slot: 13
  food:
    icon: SWEET_BERRIES
    slot: 15

storage:
  type: mysql
  host: db.internal
  port: 3306
  database: sakurashop
  username: shop
  password: KAIZEN_SECRET_2_demo

discord:
  enabled: true
  webhook: KAIZEN_SECRET_3_demo
`,
    secrets: [
      { id: "KAIZEN_SECRET_2_demo", key: "storage.password", line: 27 },
      { id: "KAIZEN_SECRET_3_demo", key: "discord.webhook", line: 31 },
    ],
  },
  {
    path: "plugins/SakuraShop/messages.yml",
    plugin: "SakuraShop",
    lang: "yaml",
    content: `prefix: "<#d9668a>Shop</#d9668a> <#5c5552>›</#5c5552> "
bought: "<prefix>You bought <amount>x <item> for <price>."
sold: "<prefix>You sold <amount>x <item> for <price>."
not-enough-money: "<prefix><#e5737a>You need <price> for that."
`,
    secrets: [],
  },
  {
    path: "plugins/Waystones/waystones.json",
    plugin: "Waystones",
    lang: "json",
    content: `{
  // Waystones players can teleport between
  "cooldownSeconds": 30,
  "costPerBlock": 0.05,
  "waystones": [
    { "name": "Spawn", "world": "world", "x": 0, "y": 72, "z": 0 },
    { "name": "Cherry Grove", "world": "world", "x": 812, "y": 96, "z": -240 }
  ]
}
`,
    secrets: [],
  },
  {
    path: "plugins/Lanterns/settings.toml",
    plugin: "Lanterns",
    lang: "toml",
    content: `# Lanterns that light up at dusk
[lights]
enabled = true
radius = 24
start = "18:30"
end = "06:00"

[effects]
particles = "CHERRY_LEAVES"
density = 0.4
`,
    secrets: [],
  },
];

function randomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => APPLY_CODE_ALPHABET[b % 32]).join("");
}

export class DemoSession implements SessionSource {
  private rev = 0;

  async load(): Promise<LoadedSession> {
    const now = Date.now();
    const withSha: UploadFile[] = await Promise.all(files.map(async (f) => ({ ...f, sha256: await sha256Hex(utf8Encode(f.content)) })));
    const upload: UploadPayload = {
      format: "kaizen.upload",
      v: 1,
      sid: "demo-session-000000000",
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 3600_000).toISOString(),
      server: { software: "Paper 1.21.11 (demo)", kaizen: "1.0.0" },
      scope: "all",
      files: withSha,
      reloadHints: {},
    };
    return {
      sid: upload.sid,
      upload,
      uploadSha256: "",
      expiresAt: new Date(now + 3600_000),
      latestRev: 0,
      pending: null,
      tag: TAG,
    };
  }

  async save(_files: ChangedFile[], rev: number): Promise<SavedChanges> {
    if (rev <= this.rev) throw new Error("stale");
    this.rev = rev;
    await new Promise((r) => setTimeout(r, 450));
    return { code: randomCode(), rev };
  }

  async discard(): Promise<void> {}
}
