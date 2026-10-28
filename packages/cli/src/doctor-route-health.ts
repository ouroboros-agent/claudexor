/**
 * `claudexor doctor`: the route-health section. The daemon's last seven days of
 * terminal runs per harness and effective access profile, projected verbatim
 * from `GET /v2/daemon/route-health`. Facts only: no threshold decides what is
 * printed beyond "this route had failures", and no line carries a verdict.
 */
import { ControlRouteHealth, type ControlRouteHealthRoute } from "@claudexor/schema";

/** Null means this engine has no route-health read (an older daemon answers 404). */
export async function readRouteHealth(
  get: (path: string) => Promise<unknown>,
): Promise<ControlRouteHealth | null> {
  try {
    return ControlRouteHealth.parse(await get("/daemon/route-health"));
  } catch (error) {
    if (error instanceof Error && (error as { status?: unknown }).status === 404) return null;
    throw error;
  }
}

/** One summary line, then one line per route that had failed runs. */
export function routeHealthLines(health: ControlRouteHealth | null): string[] {
  if (health === null) return ["? route health: unavailable from this engine version"];
  const failing = health.routes.filter((route) => route.failed > 0);
  const scope = health.complete
    ? `last ${health.windowDays} days`
    : `newest ${health.scannedRuns} runs of the last ${health.windowDays} days (${
        health.incompleteReason === "scan_bound"
          ? "scan bound reached; older runs of the window are not counted"
          : "scan stopped early"
      })`;
  return [
    `route health, ${scope}: ${health.scannedRuns} run(s) over ${health.routes.length} route(s), ${failing.length} with failures`,
    ...failing.map((route) => `    ${routeLine(route)}`),
  ];
}

function routeLine(route: ControlRouteHealthRoute): string {
  const share = Math.round((route.failed / route.runs) * 100);
  const cancelled = route.cancelled ? `, ${route.cancelled} cancelled` : "";
  const top = route.topFailures[0];
  const cause = top
    ? `; most: ${top.category}${top.code ? ` (${top.code})` : ""}${
        top.message ? ` — ${top.message}` : ""
      } ×${top.count}`
    : "";
  return `${route.harnessId} ${route.access}: ${route.failed}/${route.runs} failed (${share}%)${cancelled}${cause}`;
}
