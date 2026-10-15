import {createGatewayServer, ModelRouter, type Provider} from "./index.js";

const mock: Provider = {
  name: "local-mock",
  complete: async (request) => {
    const text = request.messages.at(-1)?.content ?? "";
    return {text: `mock: ${text}`, provider: "local-mock", model: request.model, costUsd: 0, usage: {inputTokens: text.split(/\s+/).filter(Boolean).length, outputTokens: text.split(/\s+/).filter(Boolean).length + 1}, requestId: request.requestId!};
  },
};

const port = Number(process.env.PORT ?? 8080);
const adminToken = process.env.ADMIN_TOKEN ?? "local-development-only";
const server = createGatewayServer(new ModelRouter([mock]), adminToken);
server.listen(port, "0.0.0.0", () => process.stdout.write(JSON.stringify({level: "info", event: "listening", port}) + "\n"));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
