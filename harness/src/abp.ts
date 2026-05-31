// mind2web/harness/src/abp.ts
import { ABPClient } from "agent-browser-protocol";
import sharp from "sharp";

export class AbpHelper {
  private client: ABPClient;
  private _baseUrl: string;

  constructor(port: number) {
    this._baseUrl = `http://localhost:${port}/api/v1`;
    this.client = new ABPClient(this._baseUrl);
  }

  get baseUrl(): string {
    return this._baseUrl;
  }

  /** Wait for ABP to be ready (poll status endpoint) */
  async waitForReady(timeoutMs = 30000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const status = await this.client.browser.status();
        if (status.data.ready) return;
      } catch {
        /* not ready yet */
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`ABP not ready after ${timeoutMs}ms`);
  }

  /** Get the active tab ID (first tab) */
  async getActiveTabId(): Promise<string> {
    const tabs = await this.client.tabs.list();
    if (tabs.length === 0) throw new Error("No tabs open");
    return tabs[0].id;
  }

  /** Navigate to URL and wait for the page to actually settle.
   *
   * A fixed sleep is unreliable for JS-heavy pages: on a cold load the main
   * content can still be laying out (the document briefly collapses to a
   * footer-only ~1-viewport height) when we capture, which is how the
   * pre-handoff `0000.png` ended up showing the footer instead of the homepage.
   * Instead, poll until `document.readyState === 'complete'` AND the page
   * height is stable across consecutive samples, then add a short settle.
   */
  async navigateTo(tabId: string, url: string): Promise<void> {
    await this.client.tabs.navigate(tabId, { url });
    await this.waitForPageSettled(tabId);
  }

  /** Poll the page until readyState is complete and layout height is stable. */
  async waitForPageSettled(
    tabId: string,
    { timeoutMs = 15000, stableMs = 600, pollMs = 250 }: {
      timeoutMs?: number;
      stableMs?: number;
      pollMs?: number;
    } = {},
  ): Promise<void> {
    const start = Date.now();
    let lastHeight = -1;
    let stableSince = 0;
    while (Date.now() - start < timeoutMs) {
      let ready = false;
      let height = -1;
      try {
        const res = await this.client.tabs.execute(tabId, {
          script:
            "JSON.stringify({r:document.readyState,h:document.documentElement.scrollHeight})",
        });
        const v = res.result?.value;
        if (typeof v === "string") {
          const parsed = JSON.parse(v) as { r: string; h: number };
          ready = parsed.r === "complete";
          height = Number(parsed.h) || -1;
        }
      } catch {
        /* transient — keep polling */
      }
      const now = Date.now();
      if (height === lastHeight && height > 0) {
        if (stableSince === 0) stableSince = now;
        if (ready && now - stableSince >= stableMs) return;
      } else {
        lastHeight = height;
        stableSince = 0;
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    // Timed out waiting for a clean settle — fall back to a short grace period
    // so we still capture *something* rather than throwing.
    await new Promise((r) => setTimeout(r, 500));
  }

  /** Take a screenshot and return as PNG buffer.
   *
   * Scrolls to the top first so the captured frame is the page as a user
   * would first see it (defensive — pairs with waitForPageSettled).
   */
  async takeScreenshotPng(tabId: string): Promise<Buffer> {
    try {
      await this.client.tabs.execute(tabId, { script: "window.scrollTo(0, 0)" });
    } catch {
      /* non-fatal */
    }
    const response = await this.client.tabs.screenshot(tabId, {
      markup: [],
    });
    const data = response.screenshot_after?.data;
    if (!data) throw new Error("No screenshot data in response");
    const webpBuffer = Buffer.from(data, "base64");
    return sharp(webpBuffer).png().toBuffer();
  }

  /** Trigger an ABP WAIT action and return ITS screenshot as a PNG buffer.
   *
   * This is the canonical pre-handoff capture: before the agent takes over we
   * always run a real WAIT action (an ABP action envelope, not a bare REST
   * screenshot) so the resulting frame — used as trajectory step 0 (`0000.png`)
   * — is a truthful product of a recorded browser action that observes the
   * settled landing page. Scrolls to top first so step 0 shows the page as a
   * user would first see it.
   */
  async waitAndCapturePng(tabId: string, ms = 1500): Promise<Buffer> {
    try {
      await this.client.tabs.execute(tabId, { script: "window.scrollTo(0, 0)" });
    } catch {
      /* non-fatal */
    }
    const response = await this.client.tabs.wait(tabId, {
      ms,
      screenshot: { markup: [] },
    });
    const data = response.screenshot_after?.data;
    if (!data) throw new Error("No screenshot data in WAIT response");
    const webpBuffer = Buffer.from(data, "base64");
    return sharp(webpBuffer).png().toBuffer();
  }

  /** Execute JS to get element at coordinates (before click) */
  async getElementAtPoint(
    tabId: string,
    x: number,
    y: number,
  ): Promise<string | null> {
    const script = `
      (function(x, y) {
        const el = document.elementFromPoint(x, y);
        if (!el) return null;
        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute('role') || '';
        const href = el.getAttribute('href') || '';
        const type = el.getAttribute('type') || '';
        const placeholder = el.getAttribute('placeholder') || '';
        let desc = '<' + tag;
        if (role) desc += ' role="' + role + '"';
        if (href) desc += ' href="' + href + '"';
        if (type) desc += ' type="' + type + '"';
        if (placeholder) desc += ' placeholder="' + placeholder + '"';
        desc += '>';
        return desc;
      })(${x}, ${y})
    `;
    const result = await this.client.tabs.execute(tabId, { script });
    const value = result.result?.value;
    return typeof value === "string" ? value : null;
  }

  /** Close all tabs except one (reset browser state) */
  async resetTabs(): Promise<void> {
    const tabs = await this.client.tabs.list();
    for (let i = 1; i < tabs.length; i++) {
      try {
        await this.client.tabs.close(tabs[i].id);
      } catch {
        /* ignore */
      }
    }
    if (tabs.length > 0) {
      await this.client.tabs.navigate(tabs[0].id, { url: "about:blank" });
    }
  }

  get raw() {
    return this.client;
  }
}
