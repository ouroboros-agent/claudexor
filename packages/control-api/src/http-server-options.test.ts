import { request, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonControlApiServer } from "./daemon-server.js";
import { CONTROL_HTTP_TIMEOUTS } from "./http-server-options.js";
import type { DaemonFacadeClient } from "./run-record.js";

const unused = async (): Promise<never> => {
  throw new Error("the daemon facade is not used by this test");
};
const daemon: DaemonFacadeClient = {
  enqueue: unused,
  status: unused,
  list: unused,
  cancel: unused,
};

let api: DaemonControlApiServer | null = null;
afterEach(async () => {
  await api?.stop();
  api = null;
});

describe("control API HTTP server timeouts", () => {
  it("applies explicit keep-alive, header and request timeouts to the live server", async () => {
    api = new DaemonControlApiServer({ token: "token", daemon, host: "127.0.0.1", port: 0 });
    const { host, port } = await api.start();
    const server = (api as unknown as { server: Server }).server;
    expect({
      keepAliveTimeout: server.keepAliveTimeout,
      headersTimeout: server.headersTimeout,
      requestTimeout: server.requestTimeout,
    }).toEqual(CONTROL_HTTP_TIMEOUTS);
    // Idle sockets outlive the 5 s client keep-alive expiry; headers wait
    // longer than an idle socket lives; requests are never cut mid-receipt.
    expect(server.keepAliveTimeout).toBeGreaterThan(5_000);
    expect(server.headersTimeout).toBeGreaterThan(server.keepAliveTimeout);
    expect(server.requestTimeout).toBe(0);
    // A keep-alive client is told the longer idle window.
    const keepAlive = await new Promise<string | undefined>((resolve, reject) => {
      const req = request(
        { host, port, path: "/healthz", headers: { host: "127.0.0.1" } },
        (res) => {
          res.resume();
          res.on("end", () => resolve(String(res.headers["keep-alive"])));
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(keepAlive).toBe("timeout=65");
  });
});
