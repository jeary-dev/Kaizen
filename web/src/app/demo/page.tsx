import type { Metadata } from "next";
import { headers } from "next/headers";
import { DemoEditor } from "@/components/demo/DemoEditor";

export const metadata: Metadata = {
  title: "Demo",
  description: "Try the Kaizen editor with sample Minecraft plugin configs. Nothing is uploaded.",
};

export default async function DemoPage() {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return <DemoEditor nonce={nonce} />;
}
