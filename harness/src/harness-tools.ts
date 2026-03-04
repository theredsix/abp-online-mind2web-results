// mind2web/harness/src/harness-tools.ts
//
// A small MCP server that provides harness-level tools to the naive agent.
// Currently provides `declare_result` so the agent can explicitly submit
// its final answer and stop.

import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

export interface HarnessToolsState {
  declaredResult: string | null;
  declaredStatus: "success" | "impossible";
  potentialResult: string | null;
  potentialStatus: "success" | "impossible";
}

export interface HarnessTools {
  port: number;
  state: HarnessToolsState;
  close: () => Promise<void>;
}

export async function startHarnessTools(): Promise<HarnessTools> {
  const state: HarnessToolsState = { declaredResult: null, declaredStatus: "success", potentialResult: null, potentialStatus: "success" };

  const transports = new Map<string, StreamableHTTPServerTransport>();

  function createMcpServer(): McpServer {
    const mcp = new McpServer({
      name: "harness",
      version: "1.0.0",
    });

    mcp.tool(
      "potential_solution",
      "Record a potential answer you've seen so far. Call this whenever you encounter a plausible answer while browsing — it will be used as your final answer if you run out of steps before calling declare_result. Each call overwrites the previous potential solution, so always call it with your best answer so far.",
      {
        result: z.string().describe("The potential answer to the task, or an explanation of why the task is impossible"),
        status: z.enum(["success", "impossible"]).default("success").describe("Set to 'impossible' if you believe the task cannot be accomplished"),
      },
      async ({ result, status }) => {
        state.potentialResult = result;
        state.potentialStatus = status;
        return { content: [{ type: "text", text: `Potential solution recorded (${status}).` }] };
      },
    );

    mcp.tool(
      "declare_result",
      "Declare the final answer and complete the task. Call this when you have found the answer, or when you determine the task is impossible.",
      {
        result: z.string().describe("The final answer to the task, or an explanation of why the task is impossible"),
        status: z.enum(["success", "impossible"]).default("success").describe("Set to 'impossible' if the task cannot be accomplished on the website due to missing/changed functionality or outage"),
      },
      async ({ result, status }) => {
        state.declaredResult = result;
        state.declaredStatus = status;
        return { content: [{ type: "text", text: `Result declared (${status}).` }] };
      },
    );

    return mcp;
  }

  const server = http.createServer(async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (req.method === "POST" && req.url === "/mcp") {
      // Reuse existing transport for the session, or create a new one
      let transport = sessionId ? transports.get(sessionId) : undefined;
      if (!transport) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
        });
        const mcp = createMcpServer();
        await mcp.connect(transport);
        transports.set(transport.sessionId!, transport);
      }
      await transport.handleRequest(req, res);
    } else if (req.method === "GET" && req.url === "/mcp") {
      const transport = sessionId ? transports.get(sessionId) : undefined;
      if (transport) {
        await transport.handleRequest(req, res);
      } else {
        res.writeHead(400);
        res.end("No session");
      }
    } else if (req.method === "DELETE" && req.url === "/mcp") {
      const transport = sessionId ? transports.get(sessionId) : undefined;
      if (transport) {
        await transport.handleRequest(req, res);
        transports.delete(sessionId!);
      } else {
        res.writeHead(400);
        res.end("No session");
      }
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        port,
        state,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
