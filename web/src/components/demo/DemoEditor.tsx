"use client";

import Link from "next/link";
import { useState } from "react";
import { EditorApp } from "@/components/editor/EditorApp";
import { DemoSession } from "@/lib/demo/demo-session";

export function DemoEditor({ nonce }: { nonce?: string }) {
  const [source] = useState(() => new DemoSession());
  return (
    <EditorApp
      source={source}
      nonce={nonce}
      initialFile="plugins/SakuraShop/config.yml"
      banner={
        <p className="flex-none border-b border-sakura/25 bg-sakura/10 px-4 py-1.5 text-center text-[12.5px] text-blossom">
          Demo with made-up configs. Nothing leaves this tab.{" "}
          <Link href="/" className="underline decoration-sakura/50 underline-offset-2 hover:text-text">
            How Kaizen works
          </Link>
        </p>
      }
    />
  );
}
