import Link from "next/link";
import type { ReactNode } from "react";
import { Page, Petals, REPO_URL } from "@/components/site/Site";
import { ArrowRightIcon, LockIcon, ServerIcon, ShieldIcon, UndoIcon } from "@/components/ui/icons";

export default function Home() {
  return (
    <Page>
      <section className="relative overflow-hidden">
        <Petals />
        <div className="relative mx-auto max-w-5xl px-5 pt-16 pb-20 sm:px-8 sm:pt-24 sm:pb-28">
          <p className="text-[12px] font-medium tracking-[0.3em] text-sakura uppercase">Config editor for Minecraft servers</p>
          <h1 className="mt-5 max-w-3xl text-4xl leading-[1.1] font-semibold tracking-tight text-balance sm:text-6xl">
            Edit plugin configs in your browser. <span className="text-blossom">Calmly.</span>
          </h1>
          <p className="mt-6 max-w-2xl text-lg leading-relaxed text-muted text-pretty">
            One command opens every config on your server in a real editor with live validation. Your files are encrypted before they leave the server,
            passwords never leave it at all, and every change is backed up and can be undone.
          </p>
          <div className="mt-9 flex flex-wrap gap-3">
            <Link href="/demo" className="inline-flex items-center gap-2 rounded-md bg-sakura px-5 py-2.5 text-[15px] font-medium text-ink transition-colors hover:bg-blossom">
              Try the demo <ArrowRightIcon />
            </Link>
            <a
              href={`${REPO_URL}/releases/latest`}
              className="inline-flex items-center gap-2 rounded-md border border-line-strong px-5 py-2.5 text-[15px] text-text transition-colors hover:border-faint"
            >
              Download the plugin
            </a>
          </div>
          <p className="mt-4 text-[13px] text-dim">Spigot and Paper 1.20.6 to 1.21.x · Java 21 · free and open source</p>
        </div>
      </section>

      <section aria-labelledby="how" className="border-t border-line bg-surface/50">
        <div className="mx-auto max-w-5xl px-5 py-20 sm:px-8">
          <h2 id="how" className="text-2xl font-semibold tracking-tight">
            Three steps, nothing to install for your staff
          </h2>
          <ol className="mt-10 grid gap-5 md:grid-cols-3">
            <Step n="一" title="Open">
              <Terminal lines={["/kaizen editor", "改善 › Your editor is ready.", "改善 › Open the editor · valid for 60 minutes"]} />
              <p>Kaizen collects the config files, locks every secret it finds and encrypts the rest. You get a private link.</p>
            </Step>
            <Step n="二" title="Edit">
              <Terminal lines={["shop:", "  title: \"Sakura Market\"", "  rows: 6", "  password: 🔒 locked"]} />
              <p>Search, tabs, find and replace. Mistakes like tabs in YAML or a number turned into text are flagged as you type.</p>
            </Step>
            <Step n="三" title="Apply">
              <Terminal lines={["/kaizen apply K7M2QX9P", "• plugins/Shop/config.yml (+1 −1)", "[Confirm]  [Cancel]"]} />
              <p>Review the diff, save, and paste the one-time code in game. Kaizen shows what will change before it writes anything.</p>
            </Step>
          </ol>
        </div>
      </section>

      <section aria-labelledby="safe" className="border-t border-line">
        <div className="mx-auto max-w-5xl px-5 py-20 sm:px-8">
          <h2 id="safe" className="text-2xl font-semibold tracking-tight">
            Built so a config editor can&apos;t hurt your server
          </h2>
          <div className="mt-10 grid gap-x-10 gap-y-9 sm:grid-cols-2">
            <Feature icon={<ShieldIcon />} title="End-to-end encrypted">
              Files are encrypted with AES-256-GCM on your server. The key lives in the part of the link after <code className="font-mono text-text">#</code>, which
              browsers never send to any server. The editor site only ever stores ciphertext.
            </Feature>
            <Feature icon={<LockIcon />} title="Secrets stay home">
              Passwords, tokens, API keys and webhooks are replaced by locked placeholders before upload. The real values never leave your server and are put back
              when you apply.
            </Feature>
            <Feature icon={<UndoIcon />} title="Backed up, all or nothing">
              Every apply backs up the originals first and writes atomically. If one file fails, every file is restored.{" "}
              <code className="font-mono text-text">/kaizen undo</code> takes you back.
            </Feature>
            <Feature icon={<ServerIcon />} title="No open ports">
              The plugin only makes outbound HTTPS requests. Changes are only accepted from the server that opened the session, once, before it expires, and only
              for files it uploaded.
            </Feature>
          </div>
          <p className="mt-10 text-[15px] text-muted">
            Prefer your own infrastructure? The web app is a single Docker container.{" "}
            <a href={`${REPO_URL}/blob/main/docs/deploy.md`} className="text-blossom underline decoration-sakura/40 underline-offset-4 hover:decoration-blossom">
              Self-host it
            </a>{" "}
            and point the plugin&apos;s <code className="font-mono text-text">web-url</code> at it.
          </p>
        </div>
      </section>

      <section aria-labelledby="commands" className="border-t border-line bg-surface/50">
        <div className="mx-auto max-w-5xl px-5 py-20 sm:px-8">
          <h2 id="commands" className="text-2xl font-semibold tracking-tight">
            Commands
          </h2>
          <dl className="mt-8 divide-y divide-line overflow-hidden rounded-lg border border-line">
            {[
              ["/kaizen editor [plugin|all|server]", "Open the editor for one plugin, the server's own files, or everything."],
              ["/kaizen apply <code>", "Fetch, verify and preview saved changes, then confirm to write them."],
              ["/kaizen history", "Recent applies and undos, with who made them."],
              ["/kaizen undo [id]", "Restore the files from a backup. Undo works on undos too."],
              ["/kaizen reload", "Reload config.yml and messages.yml, with clear errors if something is off."],
            ].map(([cmd, what]) => (
              <div key={cmd} className="grid gap-1 bg-ink px-5 py-4 sm:grid-cols-[minmax(0,20rem)_1fr] sm:gap-6">
                <dt className="font-mono text-[13.5px] text-blossom">{cmd}</dt>
                <dd className="text-[14.5px] text-muted">{what}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-5 text-[14px] text-dim">
            Everything needs <code className="font-mono text-muted">kaizen.use</code> (operators by default). The console can do it all.
          </p>
        </div>
      </section>
    </Page>
  );
}

function Step({ n, title, children }: { n: string; title: string; children: ReactNode }) {
  return (
    <li className="flex min-w-0 flex-col gap-4 rounded-xl border border-line bg-ink p-5">
      <p className="flex items-baseline gap-3">
        <span aria-hidden="true" className="font-kanji text-2xl text-sakura">
          {n}
        </span>
        <span className="text-lg font-medium">{title}</span>
      </p>
      <div className="flex flex-col gap-4 text-[14.5px] leading-relaxed text-muted">{children}</div>
    </li>
  );
}

function Terminal({ lines }: { lines: string[] }) {
  return (
    <pre className="overflow-x-auto rounded-lg border border-line bg-surface px-4 py-3 font-mono text-[12.5px] leading-6 text-muted">
      {lines.map((l, i) => (
        <span key={i} className={`block ${i === 0 ? "text-text" : ""}`}>
          {l}
        </span>
      ))}
    </pre>
  );
}

function Feature({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="flex gap-4">
      <span className="mt-0.5 grid size-9 flex-none place-items-center rounded-lg border border-line bg-surface text-blossom">{icon}</span>
      <div>
        <h3 className="font-medium">{title}</h3>
        <p className="mt-1.5 text-[14.5px] leading-relaxed text-muted">{children}</p>
      </div>
    </div>
  );
}
