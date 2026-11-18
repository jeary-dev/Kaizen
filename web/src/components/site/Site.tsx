import Link from "next/link";
import type { ReactNode } from "react";
import { Mark } from "@/components/ui/Mark";

export const REPO_URL = "https://github.com/jeary-dev/Kaizen";

export function SiteHeader() {
  return (
    <header className="mx-auto flex w-full max-w-5xl items-center gap-6 px-5 py-5 sm:px-8">
      <Mark />
      <nav aria-label="Site" className="ml-auto flex items-center gap-1 text-sm text-dim sm:gap-2">
        <Link href="/demo" className="rounded-md px-2.5 py-1.5 hover:text-text">
          Demo
        </Link>
        <Link href="/privacy" className="rounded-md px-2.5 py-1.5 hover:text-text">
          Privacy
        </Link>
        <a href={REPO_URL} className="rounded-md px-2.5 py-1.5 hover:text-text">
          GitHub
        </a>
      </nav>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="mt-auto border-t border-line">
      <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-x-6 gap-y-2 px-5 py-8 text-[13px] text-dim sm:px-8">
        <span>
          <span aria-hidden="true" className="font-kanji text-sakura">
            改善
          </span>{" "}
          Kaizen, a small step at a time.
        </span>
        <span className="ml-auto flex gap-5">
          <Link href="/privacy" className="hover:text-text">
            Privacy
          </Link>
          <a href={REPO_URL} className="hover:text-text">
            Source (MIT)
          </a>
        </span>
      </div>
    </footer>
  );
}

export function Page({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:bg-sakura focus:px-3 focus:py-2 focus:text-ink">
        Skip to content
      </a>
      <SiteHeader />
      <main id="main" className="flex-1">
        {children}
      </main>
      <SiteFooter />
    </div>
  );
}

/** A few petals drifting down. Purely decorative; positions and timing are classes, not inline styles (CSP). */
export function Petals() {
  // [position and size, timing]
  const petals = [
    ["left-[8%]", "[animation-delay:-2s] [animation-duration:19s]"],
    ["left-[22%] scale-75", "[animation-delay:-11s] [animation-duration:23s]"],
    ["left-[41%]", "[animation-delay:-6s] [animation-duration:21s]"],
    ["left-[63%] scale-90", "[animation-delay:-15s] [animation-duration:25s]"],
    ["left-[78%] scale-75", "[animation-delay:-3s] [animation-duration:18s]"],
    ["left-[92%]", "[animation-delay:-9s] [animation-duration:22s]"],
  ];
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden motion-reduce:hidden">
      {petals.map(([place, timing]) => (
        <span key={place} className={`absolute top-0 block ${place}`}>
          <span className={`block size-2.5 animate-petal rounded-[60%_0_60%_0] bg-blossom/50 ${timing}`} />
        </span>
      ))}
    </div>
  );
}
