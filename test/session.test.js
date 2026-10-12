import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { generateKeyPairSync } from "node:crypto";

const execFileAsync = promisify(execFile);
const cli = resolve("dist/index.js");

async function run(cwd, args, options = {}) {
  const result = await execFileAsync(process.execPath, [cli, ...args], {
    cwd,
    env: { ...process.env, ...options.env }
  });
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, true);
  return envelope.data;
}

async function runFailure(cwd, args, options = {}) {
  try {
    await execFileAsync(process.execPath, [cli, ...args], {
      cwd,
      env: { ...process.env, ...options.env }
    });
    assert.fail("expected command to fail");
  } catch (error) {
    const envelope = JSON.parse(error.stdout);
    assert.equal(envelope.ok, false);
    return envelope.error;
  }
}

function definitiveReceiptFixture(documentNumber) {
  return {
    documentNumber,
    issueDate: "2026-07-14T09:30:00Z",
    currency: "EUR",
    receiptSubtotal: 10,
    totalBeforeTax: 10,
    totalTaxAmount: 2.1,
    totalAmount: 12.1,
    taxesApplied: true,
    products: [{
      name: "Socks",
      identifier: "SKU-SOCKS",
      quantity: 1,
      unitCode: "C62",
      unitPrice: 10,
      subtotal: 10,
      total: 12.1,
      taxes: [{ rate: 21, type: "VAT", taxableAmount: 10, amount: 2.1 }]
    }],
    taxes: [{ rate: 21, type: "VAT", taxableAmount: 10, amount: 2.1 }]
  };
}

test("agentic session workflow builds an incremental receipt draft", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cheqi-cli-session-"));

  const initResult = await run(cwd, [
    "session",
    "create",
    "--session",
    "agent-a",
    "--currency",
    "EUR",
    "--document-number",
    "INV-001",
    "--card-par",
    "par-123"
  ]);
  const addResult = await run(cwd, [
    "receipt",
    "add-product",
    "--session",
    "agent-a",
    "--name",
    "Nike Shoes",
    "--price-incl",
    "200",
    "--vat",
    "21"
  ]);
  const validation = await run(cwd, ["receipt", "validate", "--session", "agent-a"]);
  const preview = await run(cwd, ["receipt", "preview", "--session", "agent-a"]);

  await run(cwd, ["session", "create", "--session", "agent-b", "--currency", "EUR", "--document-number", "INV-002"]);
  await run(cwd, ["receipt", "add-product", "--session", "agent-b", "--name", "Socks", "--price-incl", "10", "--vat", "21"]);
  const otherPreview = await run(cwd, ["receipt", "preview", "--session", "agent-b"]);

  assert.equal(initResult.sessionId, "agent-a");
  assert.deepEqual(initResult.nextStep.command, ["receipt", "add-product"]);
  assert.equal(addResult.added.name, "Nike Shoes");
  assert.equal(addResult.added.unitPrice, 165.29);
  assert.equal(addResult.totals.totalAmount, 200);
  assert.equal(validation.valid, true);
  assert.deepEqual(validation.nextStep.command, ["receipt", "finalize"]);
  assert.equal(preview.session.identificationDetails.cardDetails.paymentAccountReference, "par-123");
  assert.equal(preview.session.receipt.products.length, 1);
  assert.equal(preview.session.receipt.taxes[0].amount, 34.71);
  assert.equal(otherPreview.session.receipt.documentNumber, "INV-002");
  assert.equal(otherPreview.session.receipt.products[0].name, "Socks");

  const rawSession = await readFile(join(cwd, ".cheqi/sessions/agent-a.json"), "utf8");
  assert.equal(JSON.parse(rawSession).receipt.documentNumber, "INV-001");
});

test("errors are structured JSON envelopes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cheqi-cli-error-"));
  const error = await runFailure(cwd, ["receipt", "preview", "--session", "missing"]);

  assert.equal(error.code, "SESSION_NOT_FOUND");
  assert.equal(error.retryable, false);
  assert.equal(error.details.sessionId, "missing");
});

test("payment-type-only identification is accepted for download-link receipts", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cheqi-cli-empty-identification-"));

  const initResult = await run(cwd, [
    "session",
    "create",
    "--session",
    "download-link",
    "--currency",
    "EUR",
    "--document-number",
    "INV-DOWNLOAD",
    "--payment-type",
    "CASH"
  ]);
  await run(cwd, [
    "receipt",
    "add-product",
    "--session",
    "download-link",
    "--name",
    "Socks",
    "--price-incl",
    "10",
    "--vat",
    "21"
  ]);
  const validation = await run(cwd, ["receipt", "validate", "--session", "download-link"]);
  const preview = await run(cwd, ["receipt", "preview", "--session", "download-link"]);
  const status = await run(cwd, ["session", "status", "--session", "download-link"]);

  assert.equal(initResult.hasMatch, true);
  assert.deepEqual(initResult.nextStep.command, ["receipt", "add-product"]);
  assert.equal(validation.valid, true);
  assert.deepEqual(preview.session.identificationDetails, { paymentType: "CASH" });
  assert.equal(status.hasMatch, true);
  assert.deepEqual(status.nextStep.command, ["receipt", "validate"]);
});

test("payment-type-only session match resolves the download fallback route", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cheqi-cli-empty-match-"));
  await run(cwd, ["session", "create", "--session", "empty-match"]);

  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      requests.push({ url: req.url, body: JSON.parse(body) });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        routeFound: true,
        deliveryRouteType: "DOWNLOAD_FALLBACK",
        matchId: "match-empty",
        recipients: []
      }));
    });
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const endpoint = `http://127.0.0.1:${server.address().port}`;

  try {
    const match = await run(cwd, [
      "session", "match",
      "--session", "empty-match",
      "--card-par", "",
      "--api-key", "sk_test_x",
      "--endpoint", endpoint
    ]);
    const preview = await run(cwd, ["receipt", "preview", "--session", "empty-match"]);

    assert.equal(match.routeFound, true);
    assert.equal(match.deliveryRouteType, "DOWNLOAD_FALLBACK");
    assert.equal(match.matchId, "match-empty");
    assert.equal(match.recipientCount, 0);
    assert.deepEqual(preview.session.identificationDetails, { paymentType: "CARD_PAYMENT" });
    assert.equal(preview.session.matchResponse.matchId, "match-empty");
    assert.deepEqual(requests, [{ url: "/recipient/resolve", body: { paymentType: "CARD_PAYMENT" } }]);
  } finally {
    await new Promise((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
    });
  }
});

test("finalize matches and issues a definitive encrypted download receipt", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cheqi-cli-empty-finalize-"));
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      requests.push({ url: req.url, body: body ? JSON.parse(body) : null });
      if (req.url === "/recipient/resolve") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          routeFound: true,
          deliveryRouteType: "DOWNLOAD_FALLBACK",
          matchId: "match-finalize",
          recipients: []
        }));
      } else {
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({
          cheqiReceiptId: "CHQ-FINALIZE-1",
          createdAt: "2026-08-11T10:00:00Z",
          expiresAt: "2027-08-11T10:00:00Z"
        }));
      }
    });
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.equal(typeof address, "object");
  const endpoint = `http://127.0.0.1:${address.port}`;

  try {
    await run(cwd, [
      "session",
      "create",
      "--session",
      "empty-finalize",
      "--card-par",
      ""
    ]);
    await run(cwd, [
      "receipt",
      "add-product",
      "--session",
      "empty-finalize",
      "--name",
      "Socks",
      "--price-incl",
      "10",
      "--vat",
      "21"
    ]);
    const result = await run(cwd, [
      "receipt",
      "finalize",
      "--session",
      "empty-finalize",
      "--api-key",
      "sk_test_x",
      "--endpoint",
      endpoint,
      "--timeout",
      "2"
    ]);

    assert.equal(result.success, true);
    assert.equal(result.accepted, true);
    assert.equal(result.deliveryRouteType, "DOWNLOAD_FALLBACK");
    assert.equal(result.matchId, "match-finalize");
    assert.equal(result.cheqiReceiptId, "CHQ-FINALIZE-1");
    assert.equal(requests[0].url, "/recipient/resolve");
    assert.deepEqual(requests[0].body, { paymentType: "CARD_PAYMENT" });
    assert.equal(requests[1].url, "/receipt/download");
    assert.equal(typeof requests[1].body.ciphertext, "string");
  } finally {
    await new Promise((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
    });
  }
});

test("schema is machine readable", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cheqi-cli-schema-"));
  const schema = await run(cwd, ["schema", "receipt", "validate"]);

  assert.equal(schema.commands.length, 1);
  assert.deepEqual(schema.commands[0].command, ["receipt", "validate"]);
  assert.equal(schema.commands[0].flags[0].name, "session");
  assert.equal(schema.commands[0].responseSchema.properties.valid.const, true);
});

test("runtime version matches package version", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cheqi-cli-version-"));
  const result = await execFileAsync(process.execPath, [cli, "version"], { cwd });
  const envelope = JSON.parse(result.stdout);
  const packageJson = JSON.parse(await readFile(resolve("package.json"), "utf8"));

  assert.equal(envelope.data.version, packageJson.version);
  assert.equal(envelope.meta.version, packageJson.version);
});

test("schema includes positional arguments and response shapes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cheqi-cli-schema-shape-"));
  const schema = await run(cwd, ["schema", "receipt", "add-product"]);
  const command = schema.commands[0];

  assert.deepEqual(command.command, ["receipt", "add-product"]);
  assert.equal(command.positional[0].name, "name");
  assert.equal(command.responseSchema.properties.added.type, "object");
  assert.equal(command.responseSchema.properties.nextStep.properties.command.type, "array");
});

test("subcommand help returns schema", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cheqi-cli-help-"));
  const sessionSchema = await run(cwd, ["session", "--help"]);
  const submitSchema = await run(cwd, ["receipts", "submit", "--help"]);

  assert.deepEqual(sessionSchema.commands.map((command) => command.command[0]), ["session", "session", "session", "session"]);
  assert.deepEqual(submitSchema.commands[0].command, ["receipts", "submit"]);
});

test("auth error codes are structured", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cheqi-cli-auth-"));
  await run(cwd, ["session", "create", "--session", "s1"]);
  const required = await runFailure(cwd, ["receipt", "finalize", "--session", "s1"]);
  const conflict = await runFailure(cwd, [
    "receipt",
    "finalize",
    "--session",
    "s1",
    "--api-key",
    "sk_test",
    "--access-token",
    "token"
  ]);

  assert.equal(required.code, "AUTH_REQUIRED");
  assert.equal(conflict.code, "AUTH_CONFLICT");
});

test("verbose mode keeps stdout pure JSON and routes SDK logs to stderr", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cheqi-cli-verbose-"));
  await run(cwd, ["session", "create", "--session", "v1"]);

  // --verbose builds the SDK (which emits diagnostics). Point at an unreachable
  // endpoint so the request fails fast and deterministically.
  let stdout;
  let stderr;
  try {
    const result = await execFileAsync(
      process.execPath,
      [
        cli,
        "session",
        "match",
        "--session",
        "v1",
        "--email",
        "a@b.com",
        "--verbose",
        "--endpoint",
        "http://127.0.0.1:1",
        "--api-key",
        "sk_test_x",
        "--timeout",
        "2"
      ],
      { cwd }
    );
    ({ stdout, stderr } = result);
  } catch (error) {
    ({ stdout, stderr } = error);
  }

  // stdout must remain a single parseable JSON envelope — no interleaved logs.
  const envelope = JSON.parse(stdout);
  assert.equal(envelope.ok, false);
  // SDK diagnostics must appear on stderr, not stdout.
  assert.match(stderr, /CheqiSDK/);
  assert.doesNotMatch(stdout, /CheqiSDK/);
});

test("session create uses environment fallback", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cheqi-cli-env-"));
  await run(cwd, ["session", "create", "--session", "env-session"], {
    env: { CHEQI_ENV: "test", CHEQI_API_ENDPOINT: "https://example.invalid" }
  });

  const rawSession = await readFile(join(cwd, ".cheqi/sessions/env-session.json"), "utf8");
  const session = JSON.parse(rawSession);
  assert.equal(session.auth.env, "test");
  assert.equal(session.auth.endpoint, "https://example.invalid");
});

test("receipts submit matches then issues the definitive receipt", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cheqi-cli-submit-"));
  const receiptPath = join(cwd, "receipt.json");
  await writeFile(receiptPath, JSON.stringify(definitiveReceiptFixture("INV-SUBMIT-1")));

  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      requests.push({ url: req.url, body: body ? JSON.parse(body) : null });
      if (req.url === "/recipient/resolve") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          routeFound: true,
          deliveryRouteType: "DOWNLOAD_FALLBACK",
          matchId: "match-submit",
          recipients: []
        }));
      } else {
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ cheqiReceiptId: "CHQ-SUBMIT-1" }));
      }
    });
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const endpoint = `http://127.0.0.1:${server.address().port}`;

  try {
    const result = await run(cwd, [
      "receipts", "submit",
      "--receipt", receiptPath,
      "--match-by", "payment_type",
      "--match-value", "CASH",
      "--api-key", "sk_test_x",
      "--endpoint", endpoint,
      "--download-base-url", "https://receipt.example.test"
    ]);

    assert.equal(result.success, true);
    assert.equal(result.deliveryRouteType, "DOWNLOAD_FALLBACK");
    assert.equal(result.matchId, "match-submit");
    assert.equal(result.cheqiReceiptId, "CHQ-SUBMIT-1");
    assert.deepEqual(requests.map((request) => request.url), ["/recipient/resolve", "/receipt/download"]);
    assert.deepEqual(requests[0].body, { paymentType: "CASH" });
  } finally {
    await new Promise((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
    });
  }
});

test("receipts submit encrypts and submits a digital receipt", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cheqi-cli-digital-"));
  const receiptPath = join(cwd, "receipt.json");
  await writeFile(receiptPath, JSON.stringify(definitiveReceiptFixture("INV-DIGITAL-1")));
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicKeyB64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      requests.push({ url: req.url, body: JSON.parse(body) });
      res.writeHead(req.url === "/recipient/resolve" ? 200 : 201, { "content-type": "application/json" });
      res.end(JSON.stringify(req.url === "/recipient/resolve"
        ? { routeFound: true, deliveryRouteType: "DIGITAL", matchId: "match-digital", recipients: [{ id: "device-1", publicKey: publicKeyB64 }] }
        : { cheqiReceiptId: "CHQ-DIGITAL-1", matchId: "match-digital", status: "PENDING" }));
    });
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));

  try {
    const result = await run(cwd, [
      "receipts", "submit", "--receipt", receiptPath,
      "--match-by", "email", "--match-value", "buyer@example.test",
      "--api-key", "sk_test_x",
      "--endpoint", `http://127.0.0.1:${server.address().port}`
    ]);
    assert.equal(result.accepted, true);
    assert.equal(result.state, "DIGITAL_SUBMITTED");
    assert.equal(result.cheqiReceiptId, "CHQ-DIGITAL-1");
    assert.deepEqual(requests.map(({ url }) => url), ["/recipient/resolve", "/receipt/encrypted"]);
    assert.equal(requests[1].body.matchId, "match-digital");
    assert.equal(requests[1].body.deviceDeliveries[0].deviceRecipientId, "device-1");
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});

test("receipts submit exposes recovery data for an uncertain digital submission", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cheqi-cli-digital-retry-"));
  const receiptPath = join(cwd, "receipt.json");
  await writeFile(receiptPath, JSON.stringify(definitiveReceiptFixture("INV-DIGITAL-RETRY-1")));
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicKeyB64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    req.resume();
    req.on("end", () => {
      const matching = req.url === "/recipient/resolve";
      res.writeHead(matching ? 200 : 503, { "content-type": "application/json" });
      res.end(JSON.stringify(matching
        ? { routeFound: true, deliveryRouteType: "DIGITAL", matchId: "match-pending", recipients: [{ id: "device-1", publicKey: publicKeyB64 }] }
        : { message: "temporarily unavailable" }));
    });
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));

  try {
    const result = await run(cwd, [
      "receipts", "submit", "--receipt", receiptPath,
      "--match-by", "email", "--match-value", "buyer@example.test",
      "--api-key", "sk_test_x",
      "--endpoint", `http://127.0.0.1:${server.address().port}`,
      "--download-base-url", "https://receipt.example.test"
    ]);
    assert.equal(result.accepted, false);
    assert.equal(result.state, "DIGITAL_PENDING");
    assert.equal(result.retryable, true);
    assert.equal(result.matchId, "match-pending");
    assert.equal(result.preparedDownload.downloadUrl, result.downloadUrl);
    assert.equal(result.preparedDownload.uploadRequest.downloadId, result.downloadId);
    assert.deepEqual(requests, ["/recipient/resolve", "/receipt/encrypted"]);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});

test("receipts submit reports an email fallback without submitting a receipt", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cheqi-cli-email-"));
  const receiptPath = join(cwd, "receipt.json");
  await writeFile(receiptPath, JSON.stringify(definitiveReceiptFixture("INV-EMAIL-1")));
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ routeFound: true, deliveryRouteType: "EMAIL_FALLBACK", matchId: "match-email", recipients: [] }));
    });
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));

  try {
    const result = await run(cwd, [
      "receipts", "submit", "--receipt", receiptPath,
      "--match-by", "email", "--match-value", "buyer@example.test",
      "--api-key", "sk_test_x",
      "--endpoint", `http://127.0.0.1:${server.address().port}`
    ]);
    assert.equal(result.accepted, false);
    assert.equal(result.state, "EMAIL_FALLBACK");
    assert.equal(result.emailReceiptRequired, true);
    assert.deepEqual(requests, ["/recipient/resolve"]);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});

test("submit-download issues a client-encrypted download link end to end", async () => {
  const { decryptDownloadEnvelope, parseDownloadUrl } = await import("@cheqi/sdk/download");
  const cwd = await mkdtemp(join(tmpdir(), "cheqi-cli-submit-download-"));

  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      requests.push({ url: req.url, body: body ? JSON.parse(body) : null });
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({
        cheqiReceiptId: "CHQ-20260714-101010-ABC123",
        createdAt: "2026-07-14T10:10:10Z",
        expiresAt: "2027-07-14T10:10:10Z"
      }));
    });
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const endpoint = `http://127.0.0.1:${server.address().port}`;

  try {
    const receiptPath = join(cwd, "receipt.json");
    await writeFile(receiptPath, JSON.stringify(definitiveReceiptFixture("INV-DL-1")));

    const result = await run(cwd, [
      "receipts",
      "submit-download",
      "--receipt",
      receiptPath,
      "--api-key",
      "sk_test_x",
      "--endpoint",
      endpoint,
      "--download-base-url",
      "https://receipt.example.test",
      "--timeout",
      "2"
    ]);

    assert.equal(result.success, true);
    assert.equal(result.accepted, true);
    assert.equal(result.deliveryRouteType, "DOWNLOAD_FALLBACK");
    assert.equal(result.cheqiReceiptId, "CHQ-20260714-101010-ABC123");
    assert.match(result.downloadUrl, /^https:\/\/receipt\.example\.test\/[A-Za-z0-9_-]{22}#[A-Za-z0-9_-]{43}$/);

    // Explicit download issuance skips matching and uploads one encrypted envelope.
    assert.deepEqual(requests.map((r) => r.url), ["/receipt/download"]);

    // The uploaded blob decrypts with the key from the URL fragment and carries the definitive payload.
    const upload = requests[0].body;
    const { downloadId, contentKey } = parseDownloadUrl(result.downloadUrl);
    assert.equal(upload.downloadId, downloadId);
    assert.equal(typeof upload.templateHash, "string");
    const envelope = await decryptDownloadEnvelope(upload.ciphertext, contentKey);
    assert.equal(envelope.envelopeVersion, 2);
    const receipt = JSON.parse(envelope.documents.RECEIPT_PAYLOAD.content);
    const identification = JSON.parse(envelope.documents.IDENTIFICATION_DETAILS.content);
    assert.equal(receipt.documentNumber, "INV-DL-1");
    assert.equal(identification.paymentType, "CASH");

    // The key never left the machine: no request contains the fragment.
    assert.ok(!JSON.stringify(requests).includes(contentKey));
  } finally {
    await new Promise((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
    });
  }
});

test("submit-download preserves the prepared upload after a retryable failure", async () => {
  const { decryptDownloadEnvelope, parseDownloadUrl } = await import("@cheqi/sdk/download");
  const cwd = await mkdtemp(join(tmpdir(), "cheqi-cli-download-retry-"));
  const receiptPath = join(cwd, "receipt.json");
  await writeFile(receiptPath, JSON.stringify(definitiveReceiptFixture("INV-RETRY-1")));
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      requests.push(JSON.parse(body));
      res.writeHead(503, { "content-type": "application/json", "retry-after": "0" });
      res.end(JSON.stringify({ message: "temporarily unavailable" }));
    });
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));

  try {
    const result = await run(cwd, [
      "receipts", "submit-download", "--receipt", receiptPath,
      "--api-key", "sk_test_x",
      "--endpoint", `http://127.0.0.1:${server.address().port}`,
      "--download-base-url", "https://receipt.example.test"
    ]);
    assert.equal(result.accepted, false);
    assert.equal(result.state, "DOWNLOAD_FALLBACK");
    assert.equal(result.retryable, true);
    assert.equal(result.preparedDownload.downloadUrl, result.downloadUrl);
    assert.deepEqual(requests, Array(requests.length).fill(result.preparedDownload.uploadRequest));
    const { downloadId, contentKey } = parseDownloadUrl(result.downloadUrl);
    assert.equal(result.preparedDownload.uploadRequest.downloadId, downloadId);
    const envelope = await decryptDownloadEnvelope(result.preparedDownload.uploadRequest.ciphertext, contentKey);
    assert.equal(JSON.parse(envelope.documents.RECEIPT_PAYLOAD.content).documentNumber, "INV-RETRY-1");
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});

test("submit-download rejects non-definitive receipt input before making a request", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cheqi-cli-submit-download-invalid-"));
  const receiptPath = join(cwd, "receipt.json");
  await writeFile(receiptPath, JSON.stringify({ documentNumber: "INV-INCOMPLETE", currency: "EUR" }));

  const error = await runFailure(cwd, [
    "receipts", "submit-download",
    "--receipt", receiptPath,
    "--api-key", "sk_test_x",
    "--endpoint", "http://127.0.0.1:1"
  ]);

  assert.equal(error.code, "RECEIPT_INVALID");
  assert.match(error.message, /issueDate is required/);
});
