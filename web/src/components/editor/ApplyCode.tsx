"use client";

import { useState } from "react";
import { CheckIcon, CopyIcon } from "@/components/ui/icons";
import { displayApplyCode } from "@/lib/protocol/formats";

/** The one-time apply code, with the command ready to paste. */
export function ApplyCode({ code, compact = false, focus = false }: { code: string; compact?: boolean; focus?: boolean }) {
  const [copied, setCopied] = useState(false);
  const command = `/kaizen apply ${code}`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
    } catch {
      // Clipboard access can be denied (e.g. non-secure context); select the text instead.
      const el = document.getElementById(`kz-cmd-${code}`);
      if (el) window.getSelection()?.selectAllChildren(el);
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className={compact ? "" : "text-center"}>
      {compact ? null : (
        <p className="mb-3 text-[11px] font-medium tracking-[0.25em] text-dim uppercase">Your apply code</p>
      )}
      <p
        className={`font-mono font-medium tracking-[0.18em] text-text tabular-nums ${compact ? "text-lg" : "text-4xl sm:text-5xl"}`}
        aria-label={`Apply code ${code.split("").join(" ")}`}
      >
        {displayApplyCode(code)}
      </p>
      <div className={`mt-4 flex items-stretch gap-2 ${compact ? "" : "justify-center"}`}>
        <code
          id={`kz-cmd-${code}`}
          className="flex items-center rounded-md border border-line bg-ink px-3 py-2 font-mono text-[13px] text-muted select-all"
        >
          {command}
        </code>
        <button
          type="button"
          onClick={copy}
          autoFocus={focus}
          className="inline-flex items-center gap-1.5 rounded-md bg-sakura px-3.5 py-2 text-sm font-medium text-ink transition-colors hover:bg-blossom"
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
          <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
    </div>
  );
}
