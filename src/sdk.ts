import type {GatewayMetrics, ModelRequest, ModelResponse} from "./types.js";

export class ModelRouterClient {
  constructor(private readonly baseUrl: string, private readonly fetcher: typeof fetch = fetch) {}

  async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
    const response = await this.fetcher(new URL("/v1/chat/completions", this.baseUrl), {
      method: "POST",
      headers: {"content-type": "application/json", "x-request-id": request.requestId ?? crypto.randomUUID()},
      body: JSON.stringify(request),
      signal,
    });
    return this.decode<ModelResponse>(response);
  }

  async metrics(adminToken: string): Promise<GatewayMetrics> {
    const response = await this.fetcher(new URL("/admin/metrics", this.baseUrl), {headers: {authorization: `Bearer ${adminToken}`}});
    return this.decode<GatewayMetrics>(response);
  }

  private async decode<T>(response: Response): Promise<T> {
    const body = await response.json() as T | {error?: {message?: string}};
    if (!response.ok) throw new Error("error" in (body as object) ? (body as {error?: {message?: string}}).error?.message ?? `gateway returned ${response.status}` : `gateway returned ${response.status}`);
    return body as T;
  }
}
