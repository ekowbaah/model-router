export interface ModelRequest { prompt:string; tenantId:string; maxCostUsd:number; }
export interface ModelResponse { text:string; provider:string; costUsd:number; cached?:boolean; }
export interface Provider { name:string; complete(request:ModelRequest):Promise<ModelResponse>; }
export interface AuditEvent { tenantId:string; provider:string; outcome:"success"|"failure"; at:string; }
export class ModelRouter {
  readonly audit: AuditEvent[]=[]; private cache=new Map<string,ModelResponse>();
  constructor(private providers:Provider[]) { if(!providers.length) throw new Error("at least one provider is required"); }
  async complete(request:ModelRequest):Promise<ModelResponse> {
    if(!request.tenantId || request.maxCostUsd < 0) throw new Error("invalid request policy");
    const key=`${request.tenantId}:${request.prompt}`; const hit=this.cache.get(key); if(hit) return {...hit,cached:true};
    let last:unknown;
    for(const provider of this.providers) try { const response=await provider.complete(request); if(response.costUsd>request.maxCostUsd) throw new Error("cost policy exceeded"); this.cache.set(key,response); this.record(request,provider,"success"); return response; } catch(error){ last=error; this.record(request,provider,"failure"); }
    throw new AggregateError([last],"all providers failed");
  }
  private record(r:ModelRequest,p:Provider,outcome:AuditEvent["outcome"]){ this.audit.push({tenantId:r.tenantId,provider:p.name,outcome,at:new Date().toISOString()}); }
}
