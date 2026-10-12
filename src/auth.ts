import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";

const CLIENT_ID = "cheqi-cli";
const SCOPES = "receipt:issue company:read";
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  refresh_expires_in: number;
  company_id: string;
  scope: string;
}

interface Credentials {
  version: 1;
  endpoint: string;
  companyId: string;
  scope: string;
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
}

function credentialDir(): string {
  return process.env.CHEQI_CREDENTIALS_DIR
    ?? (process.platform === "win32"
      ? join(process.env.LOCALAPPDATA ?? homedir(), "Cheqi", "credentials")
      : join(homedir(), ".config", "cheqi", "credentials"));
}

function credentialPath(endpoint: string): string {
  const id = createHash("sha256").update(endpoint).digest("hex");
  return join(credentialDir(), `${id}.json`);
}

async function readCredentials(endpoint: string): Promise<Credentials | null> {
  const path = credentialPath(endpoint);
  try {
    const metadata = await stat(path);
    if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
      throw new Error("Credential file permissions are too broad; restrict to owner access");
    }
    const value = JSON.parse(await readFile(path, "utf8")) as Credentials;
    if (value.version !== 1 || value.endpoint !== endpoint || !value.refreshToken) {
      throw new Error("Saved CLI credentials are invalid; run cheqi auth login");
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function saveCredentials(value: Credentials): Promise<void> {
  const dir = credentialDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(dir, 0o700);
  const path = credentialPath(value.endpoint);
  const temp = join(dir, `.${randomBytes(12).toString("hex")}.tmp`);
  try {
    await writeFile(temp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    await rename(temp, path);
    if (process.platform !== "win32") await chmod(path, 0o600);
  } finally {
    await rm(temp, { force: true });
  }
}

async function tokenRequest(endpoint: string, path: string, body: object): Promise<TokenResponse> {
  const response = await fetch(new URL(path, endpoint), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error("CLI login expired or was revoked; run cheqi auth login");
    }
    throw new Error(`CLI authentication request failed (${response.status})`);
  }
  const result = await response.json() as TokenResponse;
  if (!result.access_token || !result.refresh_token || result.token_type.toLowerCase() !== "bearer"
      || !Number.isFinite(result.expires_in) || !Number.isFinite(result.refresh_expires_in)
      || !result.company_id) {
    throw new Error("Invalid CLI token response");
  }
  return result;
}

function credentialFromToken(endpoint: string, token: TokenResponse): Credentials {
  const now = Date.now();
  return {
    version: 1,
    endpoint,
    companyId: token.company_id,
    scope: token.scope,
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    accessExpiresAt: now + token.expires_in * 1000,
    refreshExpiresAt: now + token.refresh_expires_in * 1000
  };
}

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "explorer.exe" : "xdg-open";
  const child = spawn(command, [url], { stdio: "ignore", detached: true });
  child.on("error", () => console.error("Could not open a browser automatically."));
  child.unref();
}

export async function login(endpoint: string, companyId?: string, noBrowser = false): Promise<{
  companyId: string; scope: string; expiresAt: string;
}> {
  if (!endpoint.startsWith("https://") && !endpoint.startsWith("http://127.0.0.1:")) {
    throw new Error("CLI login requires an HTTPS API endpoint");
  }
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
  const state = randomBytes(32).toString("base64url");
  const server = createServer();
  let timeout: NodeJS.Timeout | undefined;
  const codePromise = new Promise<string>((resolve, reject) => {
    timeout = setTimeout(() => reject(new Error("CLI login timed out")), LOGIN_TIMEOUT_MS);
    server.on("request", (request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback" || request.method !== "GET") {
        response.writeHead(404).end();
        return;
      }
      if (url.searchParams.get("state") !== state) {
        response.writeHead(400, { "content-type": "text/plain" }).end("Invalid authorization response");
        return;
      }
      if (url.searchParams.has("error")) {
        response.writeHead(200, { "content-type": "text/plain" }).end("Cheqi authorization was declined.");
        clearTimeout(timeout);
        reject(new Error("Cheqi authorization was declined"));
        return;
      }
      if (!url.searchParams.get("code")) {
        response.writeHead(400, { "content-type": "text/plain" }).end("Authorization code missing");
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
        .end("<!doctype html><title>Cheqi CLI</title><p>Authorization complete. You may close this tab.</p>");
      clearTimeout(timeout);
      resolve(url.searchParams.get("code") as string);
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Could not start loopback callback");
    const redirectUri = `http://127.0.0.1:${address.port}/callback`;
    const url = new URL("/oauth2/authorize", endpoint);
    url.searchParams.set("client_id", CLIENT_ID);
    url.searchParams.set("scope", SCOPES);
    url.searchParams.set("state", state);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    if (companyId) url.searchParams.set("company_id", companyId);
    if (!noBrowser) console.error("Opening Cheqi authorization page in your browser...");
    console.error(`Authorization URL: ${url.toString()}`);
    if (!noBrowser) openBrowser(url.toString());
    const code = await codePromise;
    const token = await tokenRequest(endpoint, "/oauth2/cli/token", {
      client_id: CLIENT_ID, code, redirect_uri: redirectUri, code_verifier: verifier
    });
    const credentials = credentialFromToken(endpoint, token);
    await withCredentialLock(endpoint, async () => {
      try {
        const previous = await readCredentials(endpoint);
        if (previous) {
          const response = await fetch(new URL("/oauth2/cli/revoke", endpoint), {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ client_id: CLIENT_ID, refresh_token: previous.refreshToken }),
            signal: AbortSignal.timeout(15000)
          });
          if (!response.ok) throw new Error("Previous CLI login revocation failed");
        }
        await saveCredentials(credentials);
      } catch (error) {
        await fetch(new URL("/oauth2/cli/revoke", endpoint), {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ client_id: CLIENT_ID, refresh_token: token.refresh_token }),
          signal: AbortSignal.timeout(15000)
        }).catch(() => undefined);
        throw error;
      }
    });
    return {
      companyId: credentials.companyId,
      scope: credentials.scope,
      expiresAt: new Date(credentials.refreshExpiresAt).toISOString()
    };
  } finally {
    clearTimeout(timeout);
    server.close();
  }
}

export async function status(endpoint: string): Promise<{
  loggedIn: boolean; companyId?: string; scope?: string; expiresAt?: string;
}> {
  const credentials = await readCredentials(endpoint);
  if (!credentials) return { loggedIn: false };
  return {
    loggedIn: credentials.refreshExpiresAt > Date.now(),
    companyId: credentials.companyId,
    scope: credentials.scope,
    expiresAt: new Date(credentials.refreshExpiresAt).toISOString()
  };
}

export async function logout(endpoint: string): Promise<{ loggedOut: boolean }> {
  return withCredentialLock(endpoint, async () => {
    const credentials = await readCredentials(endpoint);
    if (!credentials) return { loggedOut: true };
    const response = await fetch(new URL("/oauth2/cli/revoke", endpoint), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: CLIENT_ID, refresh_token: credentials.refreshToken }),
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error(`CLI logout failed (${response.status})`);
    await rm(credentialPath(endpoint), { force: true });
    return { loggedOut: true };
  });
}

async function withCredentialLock<T>(endpoint: string, action: () => Promise<T>): Promise<T> {
  await mkdir(credentialDir(), { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(credentialDir(), 0o700);
  const path = `${credentialPath(endpoint)}.lock`;
  for (let attempt = 0; attempt < 350; attempt++) {
    try {
      const lock = await open(path, "wx", 0o600);
      try {
        return await action();
      } finally {
        await lock.close();
        await rm(path, { force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const age = Date.now() - (await stat(path).catch(() => ({ mtimeMs: Date.now() }))).mtimeMs;
      if (age > 30000) await rm(path, { force: true });
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  throw new Error("Timed out waiting for CLI credential refresh");
}

export async function savedAccessToken(endpoint: string, forceRefresh = false,
                                       failedAccessToken?: string): Promise<string | null> {
  const existing = await readCredentials(endpoint);
  if (!existing) return null;
  if (forceRefresh && failedAccessToken && existing.accessToken !== failedAccessToken) {
    return existing.accessToken;
  }
  if (!forceRefresh && existing.accessExpiresAt > Date.now() + 60000) return existing.accessToken;
  if (existing.refreshExpiresAt <= Date.now()) {
    throw new Error("CLI login expired; run cheqi auth login");
  }
  return withCredentialLock(endpoint, async () => {
    const current = await readCredentials(endpoint);
    if (!current) return null;
    if (forceRefresh && failedAccessToken && current.accessToken !== failedAccessToken) {
      return current.accessToken;
    }
    if (!forceRefresh && current.accessExpiresAt > Date.now() + 60000) return current.accessToken;
    const token = await tokenRequest(endpoint, "/oauth2/cli/refresh", {
      client_id: CLIENT_ID, refresh_token: current.refreshToken
    });
    if (token.company_id !== current.companyId) {
      throw new Error("CLI refresh returned a different company");
    }
    const rotated = credentialFromToken(endpoint, token);
    await saveCredentials(rotated);
    return rotated.accessToken;
  });
}
