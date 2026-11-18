import Link from "next/link";

/** 改善 · Kaizen. The kanji are decorative; the accessible name is "Kaizen". */
export function Mark({ href = "/", size = "md" }: { href?: string | null; size?: "md" | "lg" }) {
  const body = (
    <span className="inline-flex items-baseline gap-2.5">
      <span aria-hidden="true" className={`font-kanji text-sakura ${size === "lg" ? "text-3xl" : "text-xl"} leading-none`}>
        改善
      </span>
      <span className={`font-medium tracking-[0.2em] uppercase text-muted ${size === "lg" ? "text-sm" : "text-[11px]"}`}>Kaizen</span>
    </span>
  );
  if (href === null) return <span aria-label="Kaizen">{body}</span>;
  return (
    <Link href={href} aria-label="Kaizen home" className="rounded-md">
      {body}
    </Link>
  );
}
