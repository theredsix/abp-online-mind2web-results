// Stress test: rapid navigation via MCP (same path as mind2web agent)
// Tests whether the MCP -> ABP pipeline handles fast navigations

import Anthropic from "@anthropic-ai/sdk";

const BASE = "http://localhost:8222";

// MCP JSON-RPC helper
let msgId = 0;
async function mcpCall(method: string, params: Record<string, any> = {}) {
  const body = {
    jsonrpc: "2.0",
    id: ++msgId,
    method,
    params,
  };
  const resp = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return resp.json();
}

// Initialize MCP session
async function initMcp() {
  await mcpCall("initialize", {
    protocolVersion: "2025-03-26",
    clientInfo: { name: "stress-test", version: "1.0" },
    capabilities: {},
  });
}

// Call an MCP tool
async function callTool(name: string, args: Record<string, any>) {
  const result = await mcpCall("tools/call", { name, arguments: args });
  return result;
}

const URLS = [
  "https://www.google.com",
  "https://www.amazon.com",
  "https://www.wikipedia.org",
  "https://github.com",
  "https://www.reddit.com",
  "https://news.ycombinator.com",
  "https://www.nytimes.com",
  "https://www.bbc.com",
  "https://www.ebay.com",
  "https://stackoverflow.com",
  "https://www.apple.com",
  "https://www.microsoft.com",
  "https://www.youtube.com",
  "https://www.cnn.com",
  "https://www.espn.com",
];

async function main() {
  console.log("=== ABP Fast Navigation Stress Test (MCP) ===\n");

  // Initialize MCP
  console.log("Initializing MCP...");
  await initMcp();
  console.log("MCP initialized\n");

  // Create a tab via MCP
  console.log("Creating tab via MCP...");
  const tabResult = await callTool("browser_tabs", {
    action: "new",
    url: "https://example.com",
  });
  // Extract tab_id from result
  const tabContent = tabResult?.result?.content?.[0]?.text || "";
  console.log("Tab result:", tabContent.slice(0, 200));

  // Parse tab ID from the JSON response — MCP wraps the result
  let tabId: string;
  try {
    const parsed = JSON.parse(tabContent);
    tabId = parsed.id || parsed.tab_id || parsed.result?.id || "";
    // Check nested in events
    if (!tabId && parsed.events?.[0]?.data?.tab_id) {
      tabId = parsed.events[0].data.tab_id;
    }
  } catch {
    // Try to extract from text
    const match = tabContent.match(/"(?:tab_)?id"\s*:\s*"([A-F0-9]{32})"/);
    tabId = match ? match[1] : "";
  }

  if (!tabId) {
    console.error("Could not get tab ID");
    process.exit(1);
  }
  console.log(`Tab ID: ${tabId}\n`);

  // Test 1: Sequential rapid navigations via MCP
  console.log("=== Test 1: Sequential MCP navigations (15 navigations) ===");
  let failures = 0;
  for (let i = 0; i < 15; i++) {
    const url = URLS[i % URLS.length];
    const start = Date.now();

    try {
      const result = await callTool("browser_navigate", { url, tab_id: tabId });
      const elapsed = Date.now() - start;
      const content = result?.result?.content?.[0]?.text || "";
      const hasScreenshot = content.includes("screenshot") || result?.result?.content?.some((c: any) => c.type === "image");

      if (result?.result?.isError) {
        failures++;
        console.log(`  [${i + 1}/15] FAIL ${elapsed}ms -> ${url}`);
        console.log(`           ${content.slice(0, 200)}`);
      } else {
        console.log(`  [${i + 1}/15] OK   ${elapsed}ms -> ${url} (screenshot: ${hasScreenshot})`);
      }
    } catch (err: any) {
      failures++;
      const elapsed = Date.now() - start;
      console.log(`  [${i + 1}/15] ERR  ${elapsed}ms -> ${url}: ${err.message}`);
    }
  }
  console.log(`  Failures: ${failures}/15\n`);

  // Test 2: Navigate + immediate action (click/screenshot)
  console.log("=== Test 2: Navigate then immediate action ===");
  for (let i = 0; i < 5; i++) {
    const url = URLS[(i + 5) % URLS.length];
    console.log(`  [${i + 1}/5] Navigate to ${url}...`);

    const navStart = Date.now();
    const navResult = await callTool("browser_navigate", { url, tab_id: tabId });
    const navElapsed = Date.now() - navStart;
    const navOk = !navResult?.result?.isError;
    console.log(`    Nav: ${navOk ? "OK" : "FAIL"} ${navElapsed}ms`);

    // Immediately take a screenshot
    const shotStart = Date.now();
    const shotResult = await callTool("browser_screenshot", { tab_id: tabId });
    const shotElapsed = Date.now() - shotStart;
    const shotOk = !shotResult?.result?.isError;
    const hasImage = shotResult?.result?.content?.some((c: any) => c.type === "image");
    console.log(`    Screenshot: ${shotOk ? "OK" : "FAIL"} ${shotElapsed}ms (image: ${hasImage})`);
  }
  console.log("");

  // Test 3: Concurrent navigations via MCP (fire multiple simultaneously)
  console.log("=== Test 3: Concurrent MCP navigations (3 at once) ===");
  const concurrentUrls = URLS.slice(0, 3);
  const promises = concurrentUrls.map(async (url, i) => {
    const start = Date.now();
    try {
      const result = await callTool("browser_navigate", { url, tab_id: tabId });
      const elapsed = Date.now() - start;
      const isError = result?.result?.isError;
      return { i, url, elapsed, ok: !isError, error: isError ? result?.result?.content?.[0]?.text : "" };
    } catch (err: any) {
      return { i, url, elapsed: Date.now() - start, ok: false, error: err.message };
    }
  });

  const results = await Promise.all(promises);
  for (const r of results) {
    console.log(`  [${r.i}] ${r.ok ? "OK" : "FAIL"} ${r.elapsed}ms -> ${r.url} ${r.error ? "(" + r.error.slice(0, 100) + ")" : ""}`);
  }
  console.log("");

  // Final health check
  console.log("=== Final health check ===");
  const tabsResult = await callTool("browser_tabs", {});
  const tabsContent = tabsResult?.result?.content?.[0]?.text || "";
  console.log(`  Tabs: ${tabsContent.slice(0, 300)}`);

  // Final recovery navigate
  console.log("\n=== Recovery navigate ===");
  const recoveryResult = await callTool("browser_navigate", {
    url: "https://example.com",
    tab_id: tabId,
  });
  const recoveryOk = !recoveryResult?.result?.isError;
  console.log(`  Result: ${recoveryOk ? "OK" : "FAIL"}`);

  console.log("\n=== Stress test complete ===");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
