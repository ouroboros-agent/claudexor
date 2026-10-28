import type { IncomingMessage, ServerResponse } from "node:http";
import { ControlDaemonStatus, type ControlRunSummary } from "@claudexor/schema";
import type { DaemonFacadeClient, DaemonRunRecord } from "./run-record.js";
import type { MaintenanceRouteContext } from "./maintenance-routes.js";
import { assertOnlyQueryParams } from "./query.js";
import { requestGone } from "./request-liveness.js";
import { routeValue, serviceResponse } from "./route-stages.js";
import { scanRouteHealth } from "./route-health.js";

export interface DaemonStatusRouteContext extends MaintenanceRouteContext {
  daemon: DaemonFacadeClient;
  /** The shared cached run summarizer (GET /v2/runs' degrade contract). */
  summarize(record: DaemonRunRecord): Promise<ControlRunSummary>;
}

export async function handleDaemonStatusRoute(
  ctx: DaemonStatusRouteContext,
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (method === "GET" && path === "/daemon/status") {
    if (!ctx.daemon.health) return false;
    try {
      ctx.json(res, 200, ControlDaemonStatus.parse(await ctx.daemon.health()));
    } catch (error) {
      ctx.requestError(res, error, 500);
    }
    return true;
  }
  if (method === "GET" && path === "/daemon/route-health") {
    // Fixed seven-day window, no parameters: a query is a typed 400, never ignored.
    const query = await routeValue(ctx, res, 400, () =>
      assertOnlyQueryParams(new URL(req.url ?? "/", "http://localhost"), []),
    );
    if (!query.ok) return true;
    const health = await routeValue(ctx, res, 500, () =>
      scanRouteHealth({
        list: (page) => ctx.daemon.list({ page }),
        summarize: ctx.summarize,
        active: () => !requestGone(req, res),
      }),
    );
    // A null answer means the client left mid-scan; nothing is written.
    if (!health.ok || health.value === null) return true;
    const answer = health.value;
    return serviceResponse(ctx, res, "routeHealth", () => ctx.json(res, 200, answer));
  }
  return false;
}
