import type { Metadata } from "next";
import { headers } from "next/headers";
import { RemoteEditor } from "@/components/editor/EditorApp";

export const metadata: Metadata = {
  title: "Editor",
  robots: { index: false, follow: false },
};

/**
 * The editor. The server only renders the shell: the key is in the URL fragment, which browsers
 * never send, so decryption happens entirely in the page.
 */
export default async function EditorPage({ params }: PageProps<"/e/[sid]">) {
  const { sid } = await params;
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return <RemoteEditor sid={sid} nonce={nonce} />;
}
