import { defaultDeps, run, saveChanges } from "@/server/api";

export async function POST(request: Request, ctx: RouteContext<"/api/v1/sessions/[sid]/changes">) {
  const { sid } = await ctx.params;
  return run("save", request, defaultDeps(), (req, deps) => saveChanges(req, deps, sid));
}
