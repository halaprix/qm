import { LitElement, html } from "lit";
import { withBase } from "./core-bridge.ts";

interface LinkStatus {
  available: boolean;
  linked: boolean;
  canUnlink: boolean;
  tag?: string;
}

interface DiscordAttempt {
  user: string;
  state: string;
  nonce: string;
  expiresAt: number;
}

const ATTEMPT_KEY = "qm-discord-account";
const ATTEMPT_TTL_MS = 10 * 60_000;
const RETURN_KEYS = ["code", "state", "error", "error_description"];
let returnUrl: URL | null = null;

function discordErrorMessage(error?: string, fallback = "Couldn't connect Discord."): string {
  if (error === "link_unavailable") return "Discord linking isn't set up. Ask an administrator.";
  return fallback;
}

export function captureDiscordReturn(url: string): void {
  const parsed = new URL(url);
  const p = parsed.searchParams;
  returnUrl = p.has("state") && (p.has("code") || p.has("error")) ? parsed : null;
}

export class DiscordAccount extends LitElement {
  static properties = { user: {}, status: { state: true }, note: { state: true }, busy: { state: true } };
  user = "";
  navigate: (url: string) => void = (url) => window.location.assign(url);
  private status: LinkStatus | null = null;
  private note = "";
  private busy = false;

  protected createRenderRoot(): HTMLElement {
    return this;
  }

  protected firstUpdated(): void {
    const url = returnUrl ?? new URL(location.href);
    returnUrl = null;
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const cancelled = url.searchParams.has("error");
    if (!state || (!code && !cancelled)) return void this.load();
    const current = new URL(location.href);
    for (const key of RETURN_KEYS) current.searchParams.delete(key);
    history.replaceState(history.state, "", current);
    const attempt = this.savedAttempt();
    this.clearAttempt();
    if (!attempt || attempt.state !== state) {
      this.note =
        "This connection expired or was started in another QM account. Sign in to the account you want to connect and try again.";
      return void this.load();
    }
    if (cancelled || !code) {
      this.note = "Discord authorization was cancelled. Your QM account has not been linked.";
      return void this.load();
    }
    void this.complete(code, state, attempt.nonce);
  }

  private savedAttempt(): DiscordAttempt | null {
    try {
      const raw = sessionStorage.getItem(ATTEMPT_KEY);
      if (!raw) return null;
      const saved = JSON.parse(raw) as DiscordAttempt;
      return saved.user === this.user && saved.expiresAt > Date.now() ? saved : null;
    } catch {
      return null;
    }
  }

  private clearAttempt(): void {
    sessionStorage.removeItem(ATTEMPT_KEY);
  }

  private async load(): Promise<void> {
    try {
      const res = await fetch(withBase("/api/discord/link"), {
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
      this.status = res.ok ? ((await res.json()) as LinkStatus) : { available: false, linked: false, canUnlink: false };
    } catch {
      this.status = { available: false, linked: false, canUnlink: false };
    }
  }

  private async connect(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.note = "";
    try {
      const nonceBytes = crypto.getRandomValues(new Uint8Array(32));
      const nonce = Array.from(nonceBytes, (b) => b.toString(16).padStart(2, "0")).join("");
      const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(nonce));
      const nonceHash = Array.from(new Uint8Array(hashBuffer), (b) => b.toString(16).padStart(2, "0")).join("");

      const res = await fetch(withBase("/api/discord/link/authorize"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nonceHash }),
        signal: AbortSignal.timeout(30_000),
      });
      const result = (await res.json().catch(() => ({}))) as { url?: string; message?: string; error?: string };
      if (!res.ok || !result.url)
        throw Error(
          result.message || discordErrorMessage(result.error, "Couldn't start the Discord connection. Try again."),
        );
      const url = new URL(result.url);
      const state = url.searchParams.get("state");
      const redirectUri = url.searchParams.get("redirect_uri");
      const expectedRedirectUri = new URL(withBase("/settings"), location.origin).href;
      if (
        url.protocol !== "https:" ||
        url.hostname !== "discord.com" ||
        url.pathname !== "/oauth2/authorize" ||
        url.username ||
        url.password ||
        !state ||
        redirectUri !== expectedRedirectUri
      )
        throw Error("Could not verify the Discord authorization link.");
      sessionStorage.setItem(
        ATTEMPT_KEY,
        JSON.stringify({ user: this.user, state, nonce, expiresAt: Date.now() + ATTEMPT_TTL_MS }),
      );
      this.navigate(url.href);
    } catch (error) {
      this.note = error instanceof Error ? error.message : "Couldn't connect Discord.";
    } finally {
      this.busy = false;
    }
  }

  private async complete(code: string, state: string, nonce: string): Promise<void> {
    this.busy = true;
    try {
      const res = await fetch(withBase("/api/discord/link/complete"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, state, nonce }),
        signal: AbortSignal.timeout(45_000),
      });
      const result = (await res.json().catch(() => ({}))) as { tag?: string; message?: string; error?: string };
      if (!res.ok) {
        const msg =
          result.message || discordErrorMessage(result.error, "Could not verify your Discord account. Try again.");
        throw Error(msg);
      }
      await this.load();
    } catch (error) {
      this.note = error instanceof Error ? error.message : "Could not verify your Discord account.";
      await this.load();
    } finally {
      this.busy = false;
    }
  }

  private async disconnect(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const res = await fetch(withBase("/api/discord/link"), { method: "DELETE", signal: AbortSignal.timeout(10_000) });
      const result = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
      if (!res.ok) {
        const msg = result.message || discordErrorMessage(result.error, "Couldn't disconnect. Try again.");
        throw Error(msg);
      }
      this.note = "Discord disconnected.";
      await this.load();
    } catch (error) {
      this.note = error instanceof Error ? error.message : "Couldn't disconnect. Try again.";
    } finally {
      this.busy = false;
    }
  }

  render() {
    const s = this.status;
    if (!s) return html``;
    let body;
    if (s.linked)
      body = html`<p>Connected as ${s.tag ?? "your Discord account"}</p>
        ${
          s.canUnlink
            ? html`<button ?disabled=${this.busy} @click=${() => this.disconnect()}>Disconnect</button>`
            : html`<p class="hint">Linked by an administrator.</p>`
        }`;
    else if (s.available)
      body = html`<button ?disabled=${this.busy} @click=${() => this.connect()}>Connect Discord</button>`;
    else body = html`<p class="hint">Discord linking isn't set up. Ask an administrator.</p>`;
    return html`<div class="discord-account">
      <strong>Discord</strong> ${body} ${this.note ? html`<p class="hint">${this.note}</p>` : ""}
    </div>`;
  }
}

if (!customElements.get("qm-discord-account")) customElements.define("qm-discord-account", DiscordAccount);
