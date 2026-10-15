import {createServer, type IncomingMessage, type Server, type ServerResponse} from "node:http";
import {GatewayError} from "./errors.js";
import type {ModelRouter} from "./router.js";
import type {ModelRequest} from "./types.js";

const maxBodyBytes = 1_048_576;

export function createGatewayServer(router: ModelRouter, adminToken: string): Server {
  return createServer(async (request, response) => {
    const requestId = header(request, "x-request-id") ?? crypto.randomUUID();
    response.setHeader("x-request-id", requestId);
    try {
      if (request.method === "GET" && request.url === "/healthz") return json(response, 200, {status: "ok"});
      if (request.method === "GET" && request.url === "/readyz") return json(response, 200, {status: "ready"});
      if (request.method === "GET" && request.url === "/admin/metrics") {
        authorizeAdmin(request, adminToken);
        return json(response, 200, router.metrics);
      }
      const cacheMatch = request.url?.match(/^\/admin\/tenants\/([^/]+)\/cache$/);
      if (request.method === "DELETE" && cacheMatch) {
        authorizeAdmin(request, adminToken);
        return json(response, 200, {removed: router.clearTenantCache(decodeURIComponent(cacheMatch[1]!))});
      }
      if (request.method === "POST" && request.url === "/v1/chat/completions") {
        const input = await readJson<ModelRequest>(request);
        const result = await router.complete({...input, requestId});
        return json(response, 200, result);
      }
      return json(response, 404, {error: {code: "NOT_FOUND", message: "route not found"}});
    } catch (error) {
      const gatewayError = error instanceof GatewayError ? error : new GatewayError("INVALID_REQUEST", error instanceof Error ? error.message : String(error));
      const status = gatewayError.code === "RATE_LIMITED" ? 429 : gatewayError.code === "QUOTA_EXCEEDED" || gatewayError.code === "COST_LIMIT_EXCEEDED" ? 403 : 400;
      return json(response, status, {error: {code: gatewayError.code, message: gatewayError.message, requestId}});
    }
  });
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBodyBytes) throw new GatewayError("INVALID_REQUEST", "request body exceeds 1 MiB");
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T; }
  catch { throw new GatewayError("INVALID_REQUEST", "request body must be valid JSON"); }
}

function authorizeAdmin(request: IncomingMessage, token: string): void {
  if (!token || header(request, "authorization") !== `Bearer ${token}`) throw new GatewayError("INVALID_REQUEST", "admin authorization failed");
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {"content-type": "application/json; charset=utf-8", "cache-control": "no-store"});
  response.end(JSON.stringify(body));
}
