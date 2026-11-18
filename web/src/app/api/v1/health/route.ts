import { defaultDeps, health, run } from "@/server/api";

export function GET(request: Request) {
  return run("meta", request, defaultDeps(), health);
}
