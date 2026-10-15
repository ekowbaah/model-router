import assert from "node:assert/strict";
import test from "node:test";
import {GatewayError, InMemoryAuditSink, ModelRouter, PolicyStore, type ModelRequest, type Provider} from "./index.js";

const request = (overrides: Partial<ModelRequest> = {}): ModelRequest => ({
  tenantId: "tenant-a",
  model: "fast-model",
  messages: [{role: "user", content: "hello world"}],
  maxCostUsd: 0.1,
  ...overrides,
});

const response = (provider: string, text = "ok") => ({
  text,
  provider,
  model: "ignored-by-router",
  costUsd: 0.02,
  usage: {inputTokens: 3, outputTokens: 1},
  requestId: "ignored-by-router",
});

test("retries transient failures, falls back, audits, and caches per tenant", async () => {
  const audit = new InMemoryAuditSink();
  let firstCalls = 0;
  const unavailable: Provider = {name: "unavailable", complete: async () => { firstCalls++; throw new Error("temporary outage"); }};
  const healthy: Provider = {name: "healthy", complete: async () => response("healthy")};
  const router = new ModelRouter([unavailable, healthy], {auditSink: audit, sleep: async () => undefined, requestId: () => "req-1"});

  assert.equal((await router.complete(request())).provider, "healthy");
  assert.equal(firstCalls, 2);
  assert.equal((await router.complete(request())).cached, true);
  assert.deepEqual(audit.events.map((event) => event.outcome), ["failure", "failure", "success", "cache_hit"]);
  assert.equal(router.metrics.cacheHits, 1);
  assert.equal(router.tenantSpend("tenant-a"), 0.02);
  assert.equal((await router.complete(request({tenantId: "tenant-b"}))).cached, undefined);
});

test("enforces rate limits and daily cost reservations", async () => {
  const policy = new PolicyStore({requestsPerWindow: 1, windowMs: 60_000, dailyBudgetUsd: 0.05});
  const router = new ModelRouter([{name: "provider", complete: async () => response("provider")}], {policies: policy});
  await router.complete(request({maxCostUsd: 0.04}));
  await assert.rejects(() => router.complete(request({messages: [{role: "user", content: "different"}]})), (error: unknown) => error instanceof GatewayError && error.code === "RATE_LIMITED");

  const quotaRouter = new ModelRouter([{name: "provider", complete: async () => response("provider")}], {policies: new PolicyStore({requestsPerWindow: 10, windowMs: 60_000, dailyBudgetUsd: 0.01})});
  await assert.rejects(() => quotaRouter.complete(request({maxCostUsd: 0.02})), (error: unknown) => error instanceof GatewayError && error.code === "QUOTA_EXCEEDED");
});

test("redacts credentials and personal data before providers see prompts", async () => {
  let observed = "";
  const router = new ModelRouter([{name: "provider", complete: async (input) => { observed = input.messages[0]!.content; return response("provider"); }}]);
  await router.complete(request({messages: [{role: "user", content: "mail me@site.test with sk-abcdefghijklmnop and 4242 4242 4242 4242"}]}));
  assert.equal(observed, "mail [REDACTED] with [REDACTED] and [REDACTED]");
});

test("rejects over-budget and schema-invalid responses before fallback", async () => {
  const expensive: Provider = {name: "expensive", complete: async () => ({...response("expensive"), costUsd: 1})};
  const invalid: Provider = {name: "invalid", complete: async () => response("invalid", "not-json")};
  const valid: Provider = {name: "valid", complete: async () => response("valid", '{"answer":42}')};
  const router = new ModelRouter([expensive, invalid, valid], {attemptsPerProvider: 1});
  const result = await router.complete(request({outputValidator: (value) => typeof value === "object" && value !== null && "answer" in value}));
  assert.equal(result.provider, "valid");
});

test("streams from the first streaming provider and accounts for terminal cost", async () => {
  const provider: Provider = {
    name: "streamer",
    complete: async () => response("streamer"),
    stream: async function* () {
      yield {delta: "hel"};
      yield {delta: "lo", done: true, response: response("streamer", "hello")};
    },
  };
  const router = new ModelRouter([provider]);
  const chunks = [];
  for await (const chunk of router.stream(request())) chunks.push(chunk.delta);
  assert.deepEqual(chunks, ["hel", "lo"]);
  assert.equal(router.tenantSpend("tenant-a"), 0.02);
});

test("runs evaluation hooks only after a successful response", async () => {
  const evaluated: string[] = [];
  const router = new ModelRouter([{name: "provider", complete: async () => response("provider")}], {
    evaluationHooks: [{evaluate: (_input, result) => { evaluated.push(result.requestId); }}],
    requestId: () => "evaluated-request",
  });
  await router.complete(request());
  assert.deepEqual(evaluated, ["evaluated-request"]);
});
