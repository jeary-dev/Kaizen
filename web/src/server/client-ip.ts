import "server-only";
import { isIP } from "node:net";
import type { ClientIpSource } from "./config";

/**
 * The client IP, used only as a rate-limit key. It is never stored or logged.
 *
 * Trust model: the app listens on 127.0.0.1 only, and the only thing that can reach it is
 * cloudflared (or your reverse proxy), which overwrites the header on every request. If the app
 * were exposed directly, a client could set this header to anything, so in that setup use
 * KAIZEN_CLIENT_IP_HEADER=none. See docs/security.md.
 */
export function clientIp(headers: Headers, source: ClientIpSource): string {
  if (source === "none") return "direct";
  const raw = headers.get(source);
  if (!raw) return "unknown";
  // X-Forwarded-For may be a list: the proxy appends the address it saw last.
  const candidate = (source === "x-forwarded-for" ? raw.split(",").at(-1) ?? "" : raw).trim();
  if (!isIP(candidate)) return "unknown";
  return bucketKey(candidate);
}

/**
 * IPv6 clients usually control a whole /64, so we rate-limit by /64. Otherwise every request
 * could come from a fresh address.
 */
function bucketKey(ip: string): string {
  if (isIP(ip) !== 6) return ip;
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return mapped[1];
  const [head, tail] = ip.split("::");
  const left = head ? head.split(":") : [];
  const right = tail !== undefined && tail !== "" ? tail.split(":") : [];
  const groups = tail === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  return `${groups.slice(0, 4).map((g) => parseInt(g || "0", 16).toString(16)).join(":")}::/64`;
}
