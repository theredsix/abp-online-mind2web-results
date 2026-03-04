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

  /** Navigate to URL and wait for load */
  async navigateTo(tabId: string, url: string): Promise<void> {
    await this.client.tabs.navigate(tabId, { url });
    // Wait for page to settle
    await new Promise((r) => setTimeout(r, 3000));
  }

  /** Take a screenshot and return as PNG buffer */
  async takeScreenshotPng(tabId: string): Promise<Buffer> {
    const response = await this.client.tabs.screenshot(tabId, {
      disable_markup: ["clickable", "typeable", "scrollable", "grid", "selected"],
    });
    const data = response.screenshot_after?.data;
    if (!data) throw new Error("No screenshot data in response");
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
