import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { login, savedAccessToken, status, logout } from "../dist/auth.js";

test("saved CLI credentials rotate once across concurrent commands and revoke on logout", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cheqi-cli-credentials-"));
  process.env.CHEQI_CREDENTIALS_DIR = dir;
  let refreshes = 0;
  let revocations = 0;
  const server = createServer(async (request, response) => {
    const body = JSON.parse(await new Promise(resolve => {
      let content = "";
      request.on("data", chunk => { content += chunk; });
      request.on("end", () => resolve(content));
    }));
    assert.equal(body.client_id, "cheqi-cli");
    if (request.url === "/oauth2/cli/refresh") {
      refreshes++;
      assert.equal(body.refresh_token, "old-refresh");
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        access_token: "new-access", refresh_token: "new-refresh", token_type: "Bearer",
        expires_in: 900, refresh_expires_in: 3600, company_id: "company-1",
        scope: "receipt:issue company:read"
      }));
    } else if (request.url === "/oauth2/cli/revoke") {
      revocations++;
      assert.equal(body.refresh_token, "new-refresh");
      response.writeHead(200).end();
    } else {
      response.writeHead(404).end();
    }
  });
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${server.address().port}/`;
    const path = join(dir, `${createHash("sha256").update(endpoint).digest("hex")}.json`);
    await mkdir(dir, { recursive: true });
    await writeFile(path, JSON.stringify({
      version: 1, endpoint, companyId: "company-1", scope: "receipt:issue company:read",
      accessToken: "old-access", refreshToken: "old-refresh",
      accessExpiresAt: Date.now() - 1000, refreshExpiresAt: Date.now() + 3600000
    }), { mode: 0o600 });

    assert.deepEqual(await Promise.all([
      savedAccessToken(endpoint), savedAccessToken(endpoint)
    ]), ["new-access", "new-access"]);
    assert.equal(refreshes, 1);
    assert.equal((await status(endpoint)).companyId, "company-1");
    assert.equal(JSON.parse(await readFile(path, "utf8")).refreshToken, "new-refresh");
    assert.deepEqual(await logout(endpoint), { loggedOut: true });
    assert.equal(revocations, 1);
    assert.deepEqual(await status(endpoint), { loggedIn: false });
  } finally {
    server.close();
    delete process.env.CHEQI_CREDENTIALS_DIR;
  }
});

test("browser callback exchanges a PKCE code bound to the exact loopback redirect", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cheqi-cli-login-"));
  process.env.CHEQI_CREDENTIALS_DIR = dir;
  let authorizationUrl;
  let exchangeCount = 0;
  const originalError = console.error;
  console.error = message => {
    if (typeof message === "string" && message.startsWith("Authorization URL: ")) {
      authorizationUrl = new URL(message.slice("Authorization URL: ".length));
    }
  };
  const server = createServer(async (request, response) => {
    if (request.url !== "/oauth2/cli/token") return response.writeHead(404).end();
    exchangeCount++;
    let content = "";
    for await (const chunk of request) content += chunk;
    const body = JSON.parse(content);
    assert.equal(body.client_id, "cheqi-cli");
    assert.equal(body.code, "valid-code");
    assert.equal(body.redirect_uri, authorizationUrl.searchParams.get("redirect_uri"));
    assert.equal(createHash("sha256").update(body.code_verifier, "ascii").digest("base64url"),
      authorizationUrl.searchParams.get("code_challenge"));
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
      access_token: "access", refresh_token: "refresh", token_type: "Bearer",
      expires_in: 900, refresh_expires_in: 3600, company_id: "company-1",
      scope: "receipt:issue company:read"
    }));
  });
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${server.address().port}/`;
    const pending = login(endpoint, "company-1", true);
    for (let attempt = 0; attempt < 100 && !authorizationUrl; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(authorizationUrl);
    assert.equal(authorizationUrl.searchParams.get("code_challenge_method"), "S256");
    assert.equal(authorizationUrl.searchParams.get("company_id"), "company-1");
    const callback = new URL(authorizationUrl.searchParams.get("redirect_uri"));
    callback.searchParams.set("code", "valid-code");
    callback.searchParams.set("state", authorizationUrl.searchParams.get("state"));
    assert.equal((await fetch(callback)).status, 200);
    assert.equal((await pending).companyId, "company-1");
    assert.equal(exchangeCount, 1);
    assert.equal(await savedAccessToken(endpoint), "access");
  } finally {
    console.error = originalError;
    delete process.env.CHEQI_CREDENTIALS_DIR;
    server.close();
  }
});

test("revoked saved login gives an AUTH_REQUIRED envelope", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cheqi-cli-revoked-"));
  const server = createServer((request, response) => {
    assert.equal(request.url, "/oauth2/cli/refresh");
    response.writeHead(401).end();
  });
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${server.address().port}/`;
    const path = join(dir, `${createHash("sha256").update(endpoint).digest("hex")}.json`);
    await writeFile(path, JSON.stringify({
      version: 1, endpoint, companyId: "company-1", scope: "receipt:issue",
      accessToken: "old-access", refreshToken: "revoked-refresh",
      accessExpiresAt: Date.now() - 1000, refreshExpiresAt: Date.now() + 3600000
    }), { mode: 0o600 });
    const result = await new Promise(resolve => {
      const child = spawn(process.execPath, ["dist/index.js", "receipts", "submit-download",
        "--receipt", "missing.json", "--endpoint", endpoint], {
        cwd: new URL("..", import.meta.url),
        env: { ...process.env, CHEQI_CREDENTIALS_DIR: dir }
      });
      let stdout = "";
      child.stdout.on("data", chunk => { stdout += chunk; });
      child.on("close", code => resolve({ code, stdout }));
    });
    assert.equal(result.code, 1);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.error.code, "AUTH_REQUIRED");
    assert.match(envelope.error.message, /cheqi auth login/);
  } finally {
    server.close();
  }
});
