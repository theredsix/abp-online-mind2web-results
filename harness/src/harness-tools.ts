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

    // Accept either `result` (the canonical name) or `answer` as the payload.
    // Both are optional in the schema and coalesced at runtime so a model that
    // reaches for the intuitive `answer` key still succeeds — the terminal
    // tool call decides pass/fail, so it must not fail on a key-name guess.
    const ANSWER_FIELDS = {
      result: z
        .string()
        .optional()
        .describe("The answer to the task, or an explanation of why it is impossible. (Alias: 'answer'.)"),
      answer: z
        .string()
        .optional()
        .describe("Alias for 'result'. Provide exactly one of 'result' or 'answer'."),
      status: z
        .enum(["success", "impossible"])
        .default("success")
        .describe("Set to 'impossible' if the task cannot be accomplished."),
    };
    const missingPayload = {
      content: [
        {
          type: "text" as const,
          text: "Error: provide the answer in the 'result' field (the 'answer' alias is also accepted).",
        },
      ],
      isError: true,
    };

    mcp.tool(
      "potential_solution",
      "Record a potential answer you've seen so far. Call this whenever you encounter a plausible answer while browsing — it will be used as your final answer if you run out of steps before calling declare_result. Each call overwrites the previous potential solution, so always call it with your best answer so far.",
      ANSWER_FIELDS,
      async ({ result, answer, status }) => {
        const text = result ?? answer;
        if (text === undefined) return missingPayload;
        state.potentialResult = text;
        state.potentialStatus = status;
        return { content: [{ type: "text", text: `Potential solution recorded (${status}).` }] };
      },
    );

    mcp.tool(
      "declare_result",
      "Declare the final answer and complete the task. Call this when you have found the answer, or when you determine the task is impossible.",
      ANSWER_FIELDS,
      async ({ result, answer, status }) => {
        const text = result ?? answer;
        if (text === undefined) return missingPayload;
        state.declaredResult = text;
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
          // Register the transport only once the session id has actually been
          // assigned (during the initialize handshake). Doing it eagerly keyed
          // the map on `undefined`, so the follow-up request with a real
          // session-id header missed, spun up a fresh uninitialized transport,
          // and the server replied "Server not initialized" — making the
          // potential_solution / declare_result tools permanently unreachable.
          onsessioninitialized: (id) => {
            transports.set(id, transport!);
          },
        });
        const mcp = createMcpServer();
        await mcp.connect(transport);
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
