import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { generateKeyPairSync } from "node:crypto";

const exec = promisify(execFile);
const cli = resolve("dist/index.js");
const temp = () => mkdtemp(join(tmpdir(), "cheqi-agent-"));
async function command(cwd, args, env = {}) {
  try {
    const result = await exec(process.execPath, [cli, ...args], { cwd, env: { ...process.env, ...env } });
    return { exit: 0, envelope: JSON.parse(result.stdout), stdout: result.stdout };
  } catch (error) {
    return { exit: error.code, envelope: JSON.parse(error.stdout), stdout: error.stdout };
  }
}
async function okay(cwd, args, env) {
  const result = await command(cwd, args, env);
  assert.equal(result.exit, 0, result.stdout);
  assert.equal(result.envelope.ok, true);
  return result.envelope.data;
}
async function stub(handler) {
  const server = createServer(handler);
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return { endpoint: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((done) => server.close(done)) };
}
function fixture() {
  return { documentNumber: "INV-1", issueDate: "2026-10-12T10:00:00Z", currency: "EUR",
    receiptSubtotal: 10, totalBeforeTax: 10, totalTaxAmount: 2.1, totalAmount: 12.1, taxesApplied: true,
    products: [{ name: "Coffee", identifier: "coffee", quantity: 1, unitCode: "C62", unitPrice: 10,
      subtotal: 10, total: 12.1, taxes: [{ rate: 21, type: "VAT", taxableAmount: 10, amount: 2.1 }] }],
    taxes: [{ rate: 21, type: "VAT", taxableAmount: 10, amount: 2.1 }] };
}

test("network failures on match, finalize and submit are retryable and never echo credentials", async () => {
  const cwd = await temp();
  const key = "sk_secret_agent_readiness";
  const endpoint = "https://127.0.0.1:9";
  await okay(cwd, ["session", "create", "--session", "n", "--email", "buyer@example.test"]);
  await okay(cwd, ["receipt", "add-product", "--session", "n", "--name", "Coffee", "--price-incl", "12.1", "--vat", "21"]);
  const file = join(cwd, "receipt.json"); await writeFile(file, JSON.stringify(fixture()));
  for (const args of [
    ["session", "match", "--session", "n", "--email", "buyer@example.test"],
    ["receipt", "finalize", "--session", "n"],
    ["receipts", "submit", "--receipt", file, "--match-by", "email", "--match-value", "buyer@example.test"]
  ]) {
    const result = await command(cwd, [...args, "--api-key", key, "--endpoint", endpoint]);
    assert.equal(result.exit, 4, result.stdout);
    assert.equal(result.envelope.error.code, "NETWORK_ERROR");
    assert.equal(result.envelope.error.retryable, true);
    assert.ok(!result.stdout.includes(key));
    if (args[0] === "receipts") assert.deepEqual(result.envelope.error.details.nextStep.command, ["receipts", "submit"]);
  }
});

test("a matching outage leaves the session draft and retry can deliver digitally", async () => {
  const cwd = await temp();
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const key = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  let matchingAttempts = 0;
  const requests = [];
  const server = await stub((req, res) => {
    requests.push(req.url); req.resume(); req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/recipient/resolve" && ++matchingAttempts === 1) {
        res.statusCode = 503; res.end('{"message":"temporary outage"}');
      } else if (req.url === "/recipient/resolve") {
        res.end(JSON.stringify({ routeFound: true, deliveryRouteType: "DIGITAL", matchId: "match-recovered",
          recipients: [{ id: "device-1", publicKey: key }] }));
      } else if (req.url === "/receipt/encrypted") {
        res.statusCode = 201;
        res.end(JSON.stringify({ cheqiReceiptId: "CHQ-RECOVERED", matchId: "match-recovered", status: "PENDING" }));
      } else { res.statusCode = 404; res.end("{}"); }
    });
  });
  try {
    await okay(cwd, ["session", "create", "--session", "match-retry", "--email", "buyer@example.test"]);
    await okay(cwd, ["receipt", "add-product", "--session", "match-retry", "--name", "Coffee", "--unit-price", "10", "--vat", "21"]);
    const args = ["receipt", "finalize", "--session", "match-retry", "--api-key", "sk_test", "--endpoint", server.endpoint];
    const first = await command(cwd, args);
    assert.equal(first.exit, 4, first.stdout);
    assert.equal(first.envelope.error.code, "NETWORK_ERROR");
    assert.deepEqual(first.envelope.error.details.nextStep.command, ["receipt", "finalize"]);
    const saved = JSON.parse(await readFile(join(cwd, ".cheqi/sessions/match-retry.json"), "utf8"));
    assert.equal(saved.issue.state, "DRAFT");
    assert.ok(saved.issue.payload);
    await assert.rejects(stat(join(cwd, ".cheqi/sessions/match-retry.download.json")), { code: "ENOENT" });
    const second = await okay(cwd, args);
    assert.equal(second.state, "DIGITAL_SUBMITTED");
    assert.equal(second.cheqiReceiptId, "CHQ-RECOVERED");
    assert.deepEqual(requests, ["/recipient/resolve", "/recipient/resolve", "/receipt/encrypted"]);
  } finally { await server.close(); }
});

test("an uncertain download upload keeps its prepared ID and retries the upload", async () => {
  const cwd = await temp();
  const requests = [];
  let uploads = 0;
  const server = await stub((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      requests.push({ url: req.url, body: body ? JSON.parse(body) : null });
      res.setHeader("content-type", "application/json");
      if (req.url === "/recipient/resolve") res.end(JSON.stringify({ routeFound: true,
        deliveryRouteType: "DOWNLOAD_FALLBACK", matchId: "match-download", recipients: [] }));
      else if (req.url === "/receipt/download" && ++uploads <= 4) { res.statusCode = 503; res.end("{}"); }
      else { res.statusCode = 201; res.end(JSON.stringify({ cheqiReceiptId: "CHQ-DOWNLOAD" })); }
    });
  });
  try {
    await okay(cwd, ["session", "create", "--session", "download", "--payment-type", "CASH"]);
    await okay(cwd, ["receipt", "add-product", "--session", "download", "--name", "Coffee", "--unit-price", "10", "--vat", "21"]);
    const args = ["receipt", "finalize", "--session", "download", "--api-key", "sk_test", "--endpoint", server.endpoint];
    const first = await command(cwd, args);
    assert.equal(first.envelope.error.code, "NETWORK_ERROR");
    assert.deepEqual(first.envelope.error.details.nextStep.command, ["receipt", "finalize"]);
    const saved = JSON.parse(await readFile(join(cwd, ".cheqi/sessions/download.json"), "utf8"));
    assert.equal(saved.issue.state, "DOWNLOAD_FALLBACK");
    const second = await okay(cwd, args);
    assert.equal(second.cheqiReceiptId, "CHQ-DOWNLOAD");
    assert.deepEqual(requests.map(({ url }) => url), ["/recipient/resolve", ...Array(5).fill("/receipt/download")]);
    for (const request of requests.slice(2)) assert.deepEqual(request.body, requests[1].body);
  } finally { await server.close(); }
});

test("HTTP errors map to stable codes, status, correlation and Retry-After", async () => {
  const cwd = await temp();
  await okay(cwd, ["session", "create", "--session", "http"]);
  let status = 429;
  const server = await stub((req, res) => { req.resume(); res.writeHead(status, { "content-type": "application/json", "retry-after": "5", "x-correlation-id": "corr-test" }); res.end('{"message":"secret"}'); });
  try {
    for (const [http, code, exit] of [[429, "RATE_LIMITED", 4], [503, "API_UNAVAILABLE", 4], [400, "API_REJECTED", 1], [401, "AUTH_INVALID", 3]]) {
      status = http;
      const result = await command(cwd, ["session", "match", "--session", "http", "--email", "x@example.test", "--api-key", "sk_test", "--endpoint", server.endpoint]);
      assert.equal(result.exit, exit, result.stdout);
      assert.equal(result.envelope.error.code, code);
      assert.equal(result.envelope.error.details.httpStatus, http);
      assert.equal(result.envelope.error.details.correlationId, "corr-test");
      if (http === 429) assert.equal(result.envelope.error.details.retryAfterSeconds, 5);
    }
  } finally { await server.close(); }
  const unknown = await command(cwd, ["unknown"]);
  assert.equal(unknown.exit, 2);
  assert.equal(unknown.envelope.error.code, "COMMAND_NOT_FOUND");
});

test("session pending finalization resumes the saved payload and settles without another request", async () => {
  const cwd = await temp();
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const key = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const requests = [];
  const server = await stub((req, res) => {
    requests.push(req.url);
    req.resume(); req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/recipient/resolve") res.end(JSON.stringify({ routeFound: true, deliveryRouteType: "DIGITAL", matchId: "match-1", recipients: [{ id: "device-1", publicKey: key }] }));
      else if (req.url === "/receipt/encrypted") { res.statusCode = 503; res.end('{"message":"busy"}'); }
      else if (req.url === "/recipient/matches/match-1") res.end(JSON.stringify({ matchId: "match-1", state: "SUBMITTED", submission: { cheqiReceiptId: "CHQ-1", matchId: "match-1", status: "PENDING" } }));
      else { res.statusCode = 404; res.end("{}"); }
    });
  });
  try {
    await okay(cwd, ["session", "create", "--session", "pending", "--email", "buyer@example.test"]);
    await okay(cwd, ["receipt", "add-product", "--session", "pending", "--name", "Coffee", "--unit-price", "10", "--vat", "21"]);
    const args = ["receipt", "finalize", "--session", "pending", "--api-key", "sk_test", "--endpoint", server.endpoint];
    const first = await command(cwd, args);
    assert.equal(first.exit, 4, first.stdout);
    assert.equal(first.envelope.error.code, "RECEIPT_PENDING");
    assert.equal(first.envelope.error.details.matchId, "match-1");
    const saved = JSON.parse(await readFile(join(cwd, ".cheqi/sessions/pending.json"), "utf8"));
    assert.equal(saved.version, 2);
    assert.equal(saved.issue.state, "DIGITAL_PENDING");
    assert.equal(saved.issue.matchId, "match-1");
    assert.equal(saved.issue.payload.products[0].name, "Coffee");
    assert.ok(!JSON.stringify(saved).includes("downloadUrl"));
    const sidecar = await stat(join(cwd, ".cheqi/sessions/pending.download.json"));
    assert.equal(sidecar.mode & 0o777, 0o600);
    const edit = await command(cwd, ["receipt", "add-product", "--session", "pending", "--name", "Tea", "--price-incl", "2"]);
    assert.equal(edit.envelope.error.code, "SESSION_FINALIZED");
    const second = await okay(cwd, args);
    assert.equal(second.state, "DIGITAL_SUBMITTED");
    assert.equal(second.cheqiReceiptId, "CHQ-1");
    await assert.rejects(stat(join(cwd, ".cheqi/sessions/pending.download.json")), { code: "ENOENT" });
    const third = await okay(cwd, args);
    assert.equal(third.alreadyFinalized, true);
    const settledEdit = await command(cwd, ["receipt", "add-product", "--session", "pending", "--name", "Tea", "--price-incl", "2"]);
    assert.equal(settledEdit.envelope.error.code, "SESSION_FINALIZED");
    assert.deepEqual(requests, ["/recipient/resolve", "/receipt/encrypted", "/recipient/matches/match-1"]);
  } finally { await server.close(); }
});

test("v1 sessions finalize and direct pending receipts resume by match ID", async () => {
  const cwd = await temp();
  const dir = join(cwd, ".cheqi/sessions");
  await okay(cwd, ["session", "create", "--session", "old"]);
  const path = join(dir, "old.json");
  const old = JSON.parse(await readFile(path, "utf8"));
  old.version = 1; delete old.issue;
  old.receipt = fixture();
  old.identificationDetails = { paymentType: "CASH" };
  await writeFile(path, JSON.stringify(old));
  const requests = [];
  const server = await stub((req, res) => {
    requests.push(req.url); req.resume(); req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/recipient/resolve") res.end(JSON.stringify({ routeFound: true, deliveryRouteType: "EMAIL_FALLBACK", matchId: "match-old", recipients: [] }));
      else if (req.url === "/recipient/matches/match-direct") res.end(JSON.stringify({ matchId: "match-direct", state: "SUBMITTED", submission: { cheqiReceiptId: "CHQ-DIRECT", matchId: "match-direct", status: "PENDING" } }));
      else { res.statusCode = 404; res.end("{}"); }
    });
  });
  try {
    const result = await okay(cwd, ["receipt", "finalize", "--session", "old", "--api-key", "sk_test", "--endpoint", server.endpoint]);
    assert.equal(result.state, "EMAIL_FALLBACK");
    const saved = JSON.parse(await readFile(path, "utf8"));
    assert.equal(saved.version, 2);
    const file = join(cwd, "receipt.json"); await writeFile(file, JSON.stringify(fixture()));
    const resumed = await okay(cwd, ["receipts", "resume", "--match-id", "match-direct", "--receipt", file,
      "--api-key", "sk_test", "--endpoint", server.endpoint]);
    assert.equal(resumed.cheqiReceiptId, "CHQ-DIRECT");
    assert.deepEqual(requests, ["/recipient/resolve", "/recipient/matches/match-direct"]);
  } finally { await server.close(); }
});

test("expired digital match can upload the saved download fallback", async () => {
  const cwd = await temp();
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const key = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const requests = [];
  const server = await stub((req, res) => {
    requests.push(req.url); req.resume(); req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/recipient/resolve") res.end(JSON.stringify({ routeFound: true, deliveryRouteType: "DIGITAL", matchId: "match-expired", recipients: [{ id: "device-1", publicKey: key }] }));
      else if (req.url === "/receipt/encrypted") { res.statusCode = 503; res.end("{}"); }
      else if (req.url === "/recipient/matches/match-expired") res.end(JSON.stringify({ matchId: "match-expired", state: "EXPIRED" }));
      else if (req.url === "/receipt/download") { res.statusCode = 201; res.end(JSON.stringify({ cheqiReceiptId: "CHQ-FALLBACK" })); }
      else { res.statusCode = 404; res.end("{}"); }
    });
  });
  try {
    await okay(cwd, ["session", "create", "--session", "expired", "--email", "buyer@example.test"]);
    await okay(cwd, ["receipt", "add-product", "--session", "expired", "--name", "Coffee", "--unit-price", "10", "--vat", "21"]);
    const args = ["receipt", "finalize", "--session", "expired", "--api-key", "sk_test", "--endpoint", server.endpoint];
    assert.equal((await command(cwd, args)).envelope.error.code, "RECEIPT_PENDING");
    const expired = await command(cwd, args);
    assert.equal(expired.envelope.error.code, "RECEIPT_EXPIRED");
    const recovered = await okay(cwd, [...args, "--fallback", "download"]);
    assert.equal(recovered.state, "DOWNLOAD_FALLBACK");
    assert.equal(recovered.cheqiReceiptId, "CHQ-FALLBACK");
    assert.match(recovered.downloadUrl, /#/);
    assert.deepEqual(requests, ["/recipient/resolve", "/receipt/encrypted", "/recipient/matches/match-expired", "/receipt/download"]);
  } finally { await server.close(); }
});

test("strict flags, session IDs, product names and help follow the schema", async () => {
  const cwd = await temp();
  await okay(cwd, ["session", "create", "--session", "parse"]);
  for (const args of [
    ["receipt", "add-product", "--session", "parse", "--name", "Coffee", "--qauntity", "2", "--price-incl", "3"],
    ["receipts", "submit", "--receipt", "x", "--match-by", "email", "--match-value", "x", "--recepit", "x"]
  ]) {
    const result = await command(cwd, args);
    assert.equal(result.envelope.error.code, "FLAG_INVALID");
    assert.equal(result.envelope.error.details.suggestion, args[0] === "receipts" ? "receipt" : "quantity");
  }
  const badId = await command(cwd, ["session", "create", "--session", "agent a"]);
  assert.equal(badId.envelope.error.code, "SESSION_INVALID");
  const negative = await command(cwd, ["receipt", "add-product", "--session", "parse", "--name", "Refund", "--price-incl", "3", "--quantity", "-2"]);
  assert.equal(negative.envelope.error.code, "FLAG_INVALID");
  assert.equal(negative.envelope.error.details.flag, "quantity");
  const invalidFallback = await command(cwd, ["receipt", "finalize", "--session", "parse", "--fallback", "download"]);
  assert.equal(invalidFallback.envelope.error.code, "FLAG_INVALID");
  assert.equal(invalidFallback.envelope.error.details.state, "DRAFT");
  const help = await okay(cwd, ["receipt", "add-product", "--session", "parse", "--help"]);
  assert.deepEqual(help.commands[0].command, ["receipt", "add-product"]);
  const added = await okay(cwd, ["receipt", "add-product", "--session", "parse", "Coffee: large", "--price-incl", "3"]);
  assert.equal(added.added.name, "Coffee: large");
  const schema = await okay(cwd, ["schema"]);
  for (const entry of schema.commands) for (const flag of entry.flags) { assert.ok(flag.type); assert.ok(flag.description); }
});

test("a stale lock held by a live process cannot be stolen", async () => {
  const cwd = await temp();
  await okay(cwd, ["session", "create", "--session", "lock"]);
  const lock = join(cwd, ".cheqi/sessions/lock.json.lock");
  await writeFile(lock, JSON.stringify({ pid: process.pid }));
  const old = new Date(Date.now() - 120_000);
  await utimes(lock, old, old);
  const blocked = await command(cwd, ["receipt", "add-product", "--session", "lock", "--name", "Coffee", "--price-incl", "1"]);
  assert.equal(blocked.exit, 4, blocked.stdout);
  assert.equal(blocked.envelope.error.code, "SESSION_LOCKED");
  assert.equal(JSON.parse(await readFile(lock, "utf8")).pid, process.pid);
  await writeFile(lock, JSON.stringify({ pid: 999_999_999 }));
  await utimes(lock, old, old);
  const added = await okay(cwd, ["receipt", "add-product", "--session", "lock", "--name", "Coffee", "--price-incl", "1"]);
  assert.equal(added.added.name, "Coffee");
});

test("direct expiry does not suggest session fallback", async () => {
  const cwd = await temp();
  const file = join(cwd, "receipt.json"); await writeFile(file, JSON.stringify(fixture()));
  const server = await stub((req, res) => { req.resume(); req.on("end", () => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ matchId: "match-direct-expired", state: "EXPIRED" }));
  }); });
  try {
    const result = await command(cwd, ["receipts", "resume", "--match-id", "match-direct-expired", "--receipt", file,
      "--api-key", "sk_test", "--endpoint", server.endpoint]);
    assert.equal(result.envelope.error.code, "RECEIPT_EXPIRED");
    assert.equal(result.envelope.error.details.nextStep, undefined);
  } finally { await server.close(); }
});

test("session directory, locking, edit commands and direct validation work", async () => {
  const cwd = await temp(); const sessionsDir = join(cwd, "custom");
  const env = { CHEQI_SESSIONS_DIR: sessionsDir };
  const created = await okay(cwd, ["session", "create", "--session", "parallel"], env);
  assert.equal(created.session, join(sessionsDir, "parallel.json"));
  const override = join(cwd, "override");
  const overridden = await okay(cwd, ["session", "create", "--session", "override", "--sessions-dir", override], env);
  assert.equal(overridden.session, join(override, "override.json"));
  await Promise.all(Array.from({ length: 10 }, (_, i) => okay(cwd,
    ["receipt", "add-product", "--session", "parallel", "--name", `item-${i}`, "--price-incl", "1"], env)));
  const listed = await okay(cwd, ["receipt", "list-products", "--session", "parallel"], env);
  assert.equal(listed.products.length, 10);
  const removed = await okay(cwd, ["receipt", "remove-product", "--session", "parallel", "--line", "1"], env);
  assert.equal(removed.totals.totalAmount, 9);
  const file = join(cwd, "receipt.json"); await writeFile(file, JSON.stringify(fixture()));
  const valid = await okay(cwd, ["receipts", "validate", "--receipt", file]);
  assert.equal(valid.totals.totalAmount, 12.1);
  const invalidEnv = await command(cwd, ["session", "create", "--session", "bad", "--env", "foo"]);
  assert.equal(invalidEnv.envelope.error.code, "FLAG_INVALID");
});

test("generated skill is deterministic, indexed, bundled and installable", async () => {
  const cwd = await temp();
  const first = await readFile("skill/cheqi/SKILL.md", "utf8");
  await exec(process.execPath, ["scripts/generate-skill.mjs"]);
  const second = await readFile("skill/cheqi/SKILL.md", "utf8");
  assert.equal(second, first);
  await exec(process.execPath, ["scripts/generate-skill.mjs"]);
  assert.equal(await readFile("skill/cheqi/SKILL.md", "utf8"), second);
  const schema = await okay(cwd, ["schema"]);
  for (const entry of schema.commands) assert.ok(first.includes(`cheqi ${entry.command.join(" ")}`));
  const shown = await okay(cwd, ["skill"]);
  assert.equal(shown.content, first);
  const raw = await exec(process.execPath, [cli, "skill", "--raw"], { cwd });
  assert.equal(raw.stdout, first);
  const installed = await okay(cwd, ["skill", "install"]);
  assert.equal(await readFile(installed.path, "utf8"), first);
  await writeFile(installed.path, first.replace("cli-version: 0.4.0", "cli-version: 99.0.0"));
  const rejected = await command(cwd, ["skill", "install"]);
  assert.equal(rejected.envelope.error.code, "INPUT_INVALID");
  await okay(cwd, ["skill", "install", "--force"]);
});
