import assert from "node:assert/strict";
import test from "node:test";
import {once} from "node:events";
import {ModelRouter} from "./router.js";
import {createGatewayServer} from "./server.js";
import type {Provider} from "./types.js";

test("serves completions, health, metrics, and structured errors", async (t) => {
  const provider: Provider = {
    name: "mock",
    complete: async () => ({text: "hello", provider: "mock", model: "mock", costUsd: 0.01, usage: {inputTokens: 2, outputTokens: 1}, requestId: "mock"}),
  };
  const server = createGatewayServer(new ModelRouter([provider]), "admin-secret");
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected TCP address");
  const base = `http://127.0.0.1:${address.port}`;

  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  const completion = await fetch(`${base}/v1/chat/completions`, {method: "POST", headers: {"content-type": "application/json", "x-request-id": "request-from-client"}, body: JSON.stringify({tenantId: "tenant", model: "mock", messages: [{role: "user", content: "hi"}], maxCostUsd: 0.1})});
  assert.equal(completion.status, 200);
  assert.equal((await completion.json() as {requestId: string}).requestId, "request-from-client");

  assert.equal((await fetch(`${base}/admin/metrics`)).status, 400);
  const metrics = await fetch(`${base}/admin/metrics`, {headers: {authorization: "Bearer admin-secret"}});
  assert.equal((await metrics.json() as {successes: number}).successes, 1);

  const malformed = await fetch(`${base}/v1/chat/completions`, {method: "POST", body: "{"});
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json() as {error: {code: string}}).error.code, "INVALID_REQUEST");
});
