import Link from "next/link";
import { Page } from "@/components/site/Site";

export default function NotFound() {
  return (
    <Page>
      <div className="mx-auto max-w-md px-5 py-24 text-center">
        <p aria-hidden="true" className="font-kanji text-6xl text-sakura/70">
          迷
        </p>
        <h1 className="mt-6 text-xl font-medium">This page doesn&apos;t exist</h1>
        <p className="mt-3 text-muted">
          Looking for your editor? Editor links come from <code className="font-mono text-text">/kaizen editor</code> and include everything after the{" "}
          <code className="font-mono text-text">#</code>.
        </p>
        <Link href="/" className="mt-8 inline-block rounded-md border border-line-strong px-4 py-2 text-sm hover:border-faint">
          Back home
        </Link>
      </div>
    </Page>
  );
}
