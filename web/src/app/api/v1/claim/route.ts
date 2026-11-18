import { claim, defaultDeps, run } from "@/server/api";

export function POST(request: Request) {
  return run("claim", request, defaultDeps(), claim);
}
