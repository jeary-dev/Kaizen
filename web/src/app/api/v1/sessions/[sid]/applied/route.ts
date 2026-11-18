import { applied, defaultDeps, run } from "@/server/api";

export async function POST(request: Request, ctx: RouteContext<"/api/v1/sessions/[sid]/applied">) {
  const { sid } = await ctx.params;
  return run("plugin", request, defaultDeps(), (req, deps) => applied(req, deps, sid));
}
