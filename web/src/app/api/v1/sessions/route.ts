import { createSession, defaultDeps, run } from "@/server/api";

export function POST(request: Request) {
  return run("create", request, defaultDeps(), createSession);
}
