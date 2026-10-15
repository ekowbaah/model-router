import type {ModelRequest, ModelResponse} from "./types.js";

interface Entry {
  tenantId: string;
  model: string;
  tokens: Set<string>;
  response: ModelResponse;
  expiresAt: number;
}

export interface CacheOptions {
  ttlMs: number;
  similarityThreshold: number;
  maxEntries: number;
}

const defaults: CacheOptions = {ttlMs: 60_000, similarityThreshold: 0.92, maxEntries: 1_000};

export class SemanticCache {
  private readonly entries: Entry[] = [];
  private readonly options: CacheOptions;

  constructor(options: Partial<CacheOptions> = {}, private readonly clock = Date.now) {
    this.options = {...defaults, ...options};
  }

  get(request: ModelRequest): ModelResponse | undefined {
    this.prune();
    const tokens = tokenize(request);
    let best: {entry: Entry; score: number} | undefined;
    for (const entry of this.entries) {
      if (entry.tenantId !== request.tenantId || entry.model !== request.model) continue;
      const score = jaccard(tokens, entry.tokens);
      if (score >= this.options.similarityThreshold && (!best || score > best.score)) best = {entry, score};
    }
    return best ? {...best.entry.response, cached: true} : undefined;
  }

  set(request: ModelRequest, response: ModelResponse): void {
    this.prune();
    if (this.entries.length >= this.options.maxEntries) this.entries.shift();
    this.entries.push({tenantId: request.tenantId, model: request.model, tokens: tokenize(request), response: {...response, cached: false}, expiresAt: this.clock() + this.options.ttlMs});
  }

  clearTenant(tenantId: string): number {
    let removed = 0;
    for (let index = this.entries.length - 1; index >= 0; index--) {
      if (this.entries[index]?.tenantId === tenantId) {
        this.entries.splice(index, 1);
        removed++;
      }
    }
    return removed;
  }

  private prune(): void {
    const now = this.clock();
    for (let index = this.entries.length - 1; index >= 0; index--) {
      if ((this.entries[index]?.expiresAt ?? 0) <= now) this.entries.splice(index, 1);
    }
  }
}

function tokenize(request: ModelRequest): Set<string> {
  const content = request.messages.map((message) => `${message.role}:${message.content}`).join(" ");
  return new Set(content.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []);
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 && right.size === 0) return 1;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection++;
  return intersection / (left.size + right.size - intersection);
}
