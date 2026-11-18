import { defaultDeps, discardSession, getSession, run } from "@/server/api";

export async function GET(request: Request, ctx: RouteContext<"/api/v1/sessions/[sid]">) {
  const { sid } = await ctx.params;
  return run("read", request, defaultDeps(), (req, deps) => getSession(req, deps, sid));
}

export async function DELETE(request: Request, ctx: RouteContext<"/api/v1/sessions/[sid]">) {
  const { sid } = await ctx.params;
  return run("plugin", request, defaultDeps(), (req, deps) => discardSession(req, deps, sid));
}
