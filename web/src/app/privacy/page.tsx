import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Page, REPO_URL } from "@/components/site/Site";

export const metadata: Metadata = {
  title: "Privacy",
  description: "What the Kaizen editor site stores, for how long, and what it can never see.",
};

export default function PrivacyPage() {
  return (
    <Page>
      <article className="mx-auto max-w-2xl px-5 pt-10 pb-24 sm:px-8">
        <h1 className="text-3xl font-semibold tracking-tight">Privacy</h1>
        <p className="mt-4 text-lg leading-relaxed text-muted">
          Short version: this site stores encrypted data it can&apos;t read, deletes it within hours, and doesn&apos;t track you.
        </p>

        <Section title="What this site can never see">
          <ul className="list-disc space-y-2 pl-5">
            <li>
              <strong className="font-medium text-text">Your config files.</strong> They are encrypted on your Minecraft server with AES-256-GCM before upload,
              and decrypted only in your browser.
            </li>
            <li>
              <strong className="font-medium text-text">The key.</strong> It is in the editor link after the <code className="font-mono">#</code>. Browsers
              never send that part of a URL to a server, so it reaches neither this site nor anything in front of it.
            </li>
            <li>
              <strong className="font-medium text-text">Your passwords and tokens.</strong> Kaizen replaces secret values with locked placeholders before
              encrypting. They never leave your Minecraft server, even encrypted.
            </li>
          </ul>
        </Section>

        <Section title="What is stored, and for how long">
          <p>For each editor session, the database holds:</p>
          <ul className="mt-3 list-disc space-y-2 pl-5">
            <li>the encrypted upload and the encrypted changes you save,</li>
            <li>a random session id, the apply code, and timestamps,</li>
            <li>two one-way hashes used to check that requests come from the link holder and from the server that opened the session.</li>
          </ul>
          <p className="mt-4">
            Saved changes are deleted the moment your server fetches them. The upload is deleted once the changes are applied or the session is discarded.
            Everything else is deleted when the session expires: after one hour by default, six at most.
          </p>
        </Section>

        <Section title="What is not collected">
          <p>
            No accounts, no cookies, no analytics, no third-party scripts, fonts or embeds. IP addresses are used in memory for rate limiting and are never
            written to disk. Request bodies are never logged.
          </p>
        </Section>

        <Section title="Hosting">
          <p>
            The public instance at edit.jeary.dev runs on a private server behind Cloudflare, which terminates TLS. Cloudflare can therefore see request
            metadata and the encrypted payloads, but not their contents and not the key. You can also{" "}
            <a href={`${REPO_URL}/blob/main/docs/deploy.md`} className="text-blossom underline decoration-sakura/40 underline-offset-4 hover:decoration-blossom">
              host the editor yourself
            </a>
            .
          </p>
        </Section>

        <Section title="Questions">
          <p>
            Kaizen is open source, so all of this can be checked in the code. For anything else, open an issue on{" "}
            <a href={REPO_URL} className="text-blossom underline decoration-sakura/40 underline-offset-4 hover:decoration-blossom">
              GitHub
            </a>
            .
          </p>
        </Section>
      </article>
    </Page>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="text-xl font-medium">{title}</h2>
      <div className="mt-3 text-[15.5px] leading-relaxed text-muted">{children}</div>
    </section>
  );
}
