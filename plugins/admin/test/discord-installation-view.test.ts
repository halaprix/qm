import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { buildSync } from "esbuild";
import { JSDOM } from "jsdom";

const bundle = buildSync({
  entryPoints: [new URL("../ui/integrations.ts", import.meta.url).pathname],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "ui",
}).outputFiles[0].text;

async function render(
  data: Record<string, unknown>,
  onApi?: (method: string, path: string, body?: unknown) => unknown,
) {
  const dom = new JSDOM(readFileSync(new URL("../public/index.html", import.meta.url), "utf8"), {
    runScripts: "outside-only",
    url: "http://localhost/admin/connectors",
  });
  const windowAny = dom.window as unknown as {
    __onApi?: (method: string, path: string, body?: unknown) => unknown;
    __data?: Record<string, unknown>;
    confirm: (msg?: string) => boolean;
  };
  windowAny.__onApi = onApi;
  windowAny.__data = data;
  windowAny.confirm = () => true;
  dom.window.eval(
    bundle +
      ';window.ui=ui;ui.mountCards();ui.configure({api:async(method,path,body)=>{if(window.__onApi){const custom=window.__onApi(method,path,body);if(custom&&typeof custom==="object"&&"ok" in custom)return custom;}return {ok:true,data:window.__data};},orgScope:()=>"org:test",connectorName:x=>x,fmtTime:x=>x});',
  );
  await dom.window.eval("ui.loadDiscordInstallation()");
  test.after(() => dom.window.close());
  return { $, dom };
  function $(id: string) {
    return dom.window.document.getElementById(id) as any;
  }
}

test("the Discord card shows the bot and lists and never renders a token", async () => {
  const { $ } = await render({
    configured: true,
    disabled: false,
    source: "admin",
    botTag: "qm-bot",
    allowUserIds: ["123456789012345678"],
    guildIds: ["900000000000000000"],
    internalRoleIds: [],
    principalDeliveries: true,
    oauthConfigured: true,
    redirectUri: "https://agent.example/settings",
    botToken: "LEAKED_TOKEN",
  });
  assert.match($("discord-installation-state").textContent, /Connected as qm-bot/);
  for (const id of ["discord-bot-token", "discord-oauth-client-secret"]) {
    assert.equal(($(id) as HTMLInputElement).type, "password");
    assert.equal(($(id) as HTMLInputElement).value, "");
    assert.equal(($(id) as HTMLInputElement).getAttribute("autocomplete"), "new-password");
  }
  assert.equal(($("discord-redirect-uri") as HTMLInputElement).value, "https://agent.example/settings");
  assert.equal(($("discord-guild-ids") as HTMLInputElement).value, "900000000000000000");
  assert.equal(($("discord-principal-deliveries") as HTMLInputElement).checked, true);
  assert.equal($("card-discord-installation").innerHTML.includes("LEAKED_TOKEN"), false);
});

test("shows correct title for each configuration state", async () => {
  const env = await render({ configured: false, source: "environment" });
  assert.equal(env.$("discord-installation-state").textContent, "Using environment config");
  assert.equal(env.$("discord-remove").classList.contains("hidden"), true);

  const disabled = await render({ configured: false, disabled: true, source: "disabled" });
  assert.equal(disabled.$("discord-installation-state").textContent, "Disconnected");
  assert.equal(disabled.$("discord-remove").classList.contains("hidden"), true);

  const unconfigured = await render({ configured: false, disabled: false, source: "none" });
  assert.equal(unconfigured.$("discord-installation-state").textContent, "Not configured");
  assert.equal(unconfigured.$("discord-remove").classList.contains("hidden"), true);
});

test("save sends the lists as arrays and omits an empty token and empty secret", async () => {
  const sent: unknown[] = [];
  const { $, dom } = await render(
    {
      configured: true,
      source: "admin",
      allowUserIds: [],
      guildIds: [],
      internalRoleIds: [],
      principalDeliveries: false,
    },
    (m: string, _p: string, b: unknown) => {
      if (m === "PUT") sent.push(b);
    },
  );
  ($("discord-guild-ids") as HTMLInputElement).value = "900000000000000000, 900000000000000001";
  $("discord-guild-ids").dispatchEvent(new dom.window.Event("input"));
  ($("discord-save") as HTMLButtonElement).click();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(JSON.parse(JSON.stringify(sent[0])), {
    allowUserIds: [],
    guildIds: ["900000000000000000", "900000000000000001"],
    internalRoleIds: [],
    principalDeliveries: false,
  });
  assert.equal("botToken" in (sent[0] as Record<string, unknown>), false);
  assert.equal("oauthClientSecret" in (sent[0] as Record<string, unknown>), false);
});

test("save includes token and oauth secret when provided and clears inputs after save succeeds", async () => {
  const sent: unknown[] = [];
  const { $, dom } = await render(
    {
      configured: true,
      source: "admin",
      allowUserIds: [],
      guildIds: [],
      internalRoleIds: [],
      principalDeliveries: true,
    },
    (m: string, _p: string, b: unknown) => {
      if (m === "PUT") sent.push(b);
    },
  );
  ($("discord-bot-token") as HTMLInputElement).value = "token123";
  $("discord-bot-token").dispatchEvent(new dom.window.Event("input"));
  ($("discord-oauth-client-secret") as HTMLInputElement).value = "secret456";
  $("discord-oauth-client-secret").dispatchEvent(new dom.window.Event("input"));
  assert.equal($("card-discord-installation").innerHTML.includes("token123"), false);
  assert.equal($("card-discord-installation").innerHTML.includes("secret456"), false);
  ($("discord-save") as HTMLButtonElement).click();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((sent[0] as Record<string, unknown>).botToken, "token123");
  assert.equal((sent[0] as Record<string, unknown>).oauthClientSecret, "secret456");
  assert.equal(($("discord-bot-token") as HTMLInputElement).value, "");
  assert.equal(($("discord-oauth-client-secret") as HTMLInputElement).value, "");
});

test("secrets are cleared after save even if the save fails", async () => {
  const { $, dom } = await render(
    {
      configured: true,
      source: "admin",
      allowUserIds: [],
      guildIds: [],
      internalRoleIds: [],
      principalDeliveries: true,
    },
    (m: string) => {
      if (m === "PUT") return { ok: false, data: { message: "Invalid credentials" } };
    },
  );
  ($("discord-bot-token") as HTMLInputElement).value = "failing-token";
  $("discord-bot-token").dispatchEvent(new dom.window.Event("input"));
  ($("discord-oauth-client-secret") as HTMLInputElement).value = "failing-secret";
  $("discord-oauth-client-secret").dispatchEvent(new dom.window.Event("input"));
  ($("discord-save") as HTMLButtonElement).click();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(($("discord-bot-token") as HTMLInputElement).value, "");
  assert.equal(($("discord-oauth-client-secret") as HTMLInputElement).value, "");
  assert.match($("card-discord-installation").textContent, /Invalid credentials/);
});

test("error messages render as textContent and do not inject markup", async () => {
  const maliciousMessage = '<img src="x" onerror="alert(1)">';
  const { $ } = await render(
    {
      configured: true,
      source: "admin",
      allowUserIds: [],
      guildIds: [],
      internalRoleIds: [],
      principalDeliveries: true,
    },
    (m: string) => {
      if (m === "PUT") return { ok: false, data: { message: maliciousMessage } };
    },
  );
  ($("discord-save") as HTMLButtonElement).click();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal($("card-discord-installation").querySelector("img"), null);
  assert.match($("card-discord-installation").textContent, /<img src="x" onerror="alert\(1\)">/);
});

test("disconnect cancels when confirm returns false", async () => {
  const sent: string[] = [];
  const { $, dom } = await render(
    {
      configured: true,
      source: "admin",
      allowUserIds: [],
      guildIds: [],
      internalRoleIds: [],
      principalDeliveries: true,
    },
    (m: string) => {
      sent.push(m);
    },
  );
  dom.window.confirm = () => false;
  ($("discord-remove") as HTMLButtonElement).click();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent.includes("DELETE"), false);
});

test("disconnect calls DELETE when confirm returns true", async () => {
  const sent: string[] = [];
  const { $, dom } = await render(
    {
      configured: true,
      source: "admin",
      allowUserIds: [],
      guildIds: [],
      internalRoleIds: [],
      principalDeliveries: true,
    },
    (m: string) => {
      sent.push(m);
    },
  );
  dom.window.confirm = () => true;
  ($("discord-remove") as HTMLButtonElement).click();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent.includes("DELETE"), true);
});

test("proxy allowlist forwards GET, PUT, and DELETE for discord-installation and rejects POST", async () => {
  const calls: { method: string; url: string }[] = [];
  const core = createServer((req: IncomingMessage, res) => {
    calls.push({ method: req.method ?? "", url: req.url ?? "" });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((r) => core.listen(0, r));
  const corePort = (core.address() as AddressInfo).port;
  process.env.CORE_API_URL = `http://localhost:${corePort}`;
  process.env.CORE_SIGNING_SECRET = "admin-discord-proxy-secret";

  const { server } = await import("../src/index.ts");
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;

  test.after(() => {
    server.close();
    if (core.listening) core.close();
  });

  const auth = { cookie: "admin=U-admin" };
  const getRes = await fetch(`${base}/api/discord-installation`, { headers: auth });
  assert.equal(getRes.status, 200);
  assert.equal(calls.at(-1)?.method, "GET");
  assert.equal(calls.at(-1)?.url, "/v1/admin/discord-installation");

  const putRes = await fetch(`${base}/api/discord-installation`, {
    method: "PUT",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ allowUserIds: [] }),
  });
  assert.equal(putRes.status, 200);
  assert.equal(calls.at(-1)?.method, "PUT");
  assert.equal(calls.at(-1)?.url, "/v1/admin/discord-installation");

  const deleteRes = await fetch(`${base}/api/discord-installation`, {
    method: "DELETE",
    headers: auth,
  });
  assert.equal(deleteRes.status, 200);
  assert.equal(calls.at(-1)?.method, "DELETE");
  assert.equal(calls.at(-1)?.url, "/v1/admin/discord-installation");

  const postRes = await fetch(`${base}/api/discord-installation`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(postRes.status, 404);
});

test("save sends principalDeliveries true by default even if load fails", async () => {
  const sent: unknown[] = [];
  const { $ } = await render({}, (m: string, _p: string, b: unknown) => {
    if (m === "GET") return { ok: false, data: { message: "Server error" } };
    if (m === "PUT") {
      sent.push(b);
      return { ok: true, data: {} };
    }
  });
  ($("discord-save") as HTMLButtonElement).click();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((sent[0] as Record<string, unknown>)?.principalDeliveries, true);
});

test("renders application id and redirect URI and copies redirect URI to clipboard", async () => {
  let copied = "";
  const { $, dom } = await render({
    configured: true,
    source: "admin",
    applicationId: "987654321098765432",
    redirectUri: "https://agent.example/settings",
  });
  const appIdInput = $("discord-application-id") as HTMLInputElement;
  assert.equal(appIdInput.value, "987654321098765432");
  assert.equal(appIdInput.readOnly, true);

  const redirectInput = $("discord-redirect-uri") as HTMLInputElement;
  assert.equal(redirectInput.value, "https://agent.example/settings");
  assert.equal(redirectInput.readOnly, true);

  Object.defineProperty(dom.window.navigator, "clipboard", {
    value: {
      writeText: async (text: string) => {
        copied = text;
      },
    },
    configurable: true,
  });

  ($("discord-copy-redirect-uri") as HTMLButtonElement).click();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(copied, "https://agent.example/settings");
});

test("typed but unsaved token is cleared when navigating away and back", async () => {
  const { $, dom } = await render({
    configured: true,
    source: "admin",
  });
  ($("discord-bot-token") as HTMLInputElement).value = "unsaved-token";
  $("discord-bot-token").dispatchEvent(new dom.window.Event("input"));
  ($("discord-oauth-client-secret") as HTMLInputElement).value = "unsaved-secret";
  $("discord-oauth-client-secret").dispatchEvent(new dom.window.Event("input"));
  await dom.window.eval("ui.loadDiscordInstallation()");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(($("discord-bot-token") as HTMLInputElement).value, "");
  assert.equal(($("discord-oauth-client-secret") as HTMLInputElement).value, "");
});

test("copy redirect URI falls back to execCommand when clipboard is unavailable", async () => {
  const { $, dom } = await render({
    configured: true,
    source: "admin",
    redirectUri: "https://agent.example/settings",
  });
  Object.defineProperty(dom.window.navigator, "clipboard", {
    value: undefined,
    configurable: true,
  });
  let execCalledWith = "";
  dom.window.document.execCommand = (command: string) => {
    execCalledWith = command;
    return true;
  };
  ($("discord-copy-redirect-uri") as HTMLButtonElement).click();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(execCalledWith, "copy");
  assert.equal(($("discord-copy-redirect-uri") as HTMLButtonElement).textContent, "Copied");
});
