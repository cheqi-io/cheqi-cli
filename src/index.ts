#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile, open, stat, chmod } from "node:fs/promises";
import { resolve } from "node:path";
import { stdin } from "node:process";
import {
  CheqiSDK,
  CheqiApiError,
  CheqiSDKError,
  EncryptionError,
  SubmissionInProgressError,
  createReceiptPayload,
  Environment,
  NoopLogger,
  type ReceiptResult,
  type Logger,
  type IdentificationDetails,
  type ReceiptPayload,
  type ReceiptPayloadInput
} from "@cheqi/sdk";
import { commands, ERROR_DEFINITIONS } from "./schema.js";
import { parseDownloadUrl } from "@cheqi/sdk/download";
import type { PreparedReceiptDownload } from "@cheqi/sdk";

const VERSION = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
).version as string;
const SESSIONS_DIR = ".cheqi/sessions";
let lastRetryAfterSeconds: number | undefined;
let lastMatchSucceeded = false;
let activeCommandPath: string[] = [];
let sessionsDir = resolve(process.env.CHEQI_SESSIONS_DIR ?? SESSIONS_DIR);

/**
 * Logger that writes every level to stderr, keeping stdout reserved exclusively
 * for the machine-readable JSON envelope. Used when --verbose is set so that
 * SDK diagnostics never corrupt the parsed output for agentic consumers.
 *
 * (The SDK's built-in ConsoleLogger sends info/debug to stdout, which would
 * interleave log lines into the JSON envelope.)
 */
class StderrLogger implements Logger {
  constructor(private readonly prefix: string = "CheqiSDK") {}

  debug(message: string, ...args: unknown[]): void {
    console.error(`[${this.prefix}] ${message}`, ...args);
  }
  info(message: string, ...args: unknown[]): void {
    console.error(`[${this.prefix}] ${message}`, ...args);
  }
  warn(message: string, ...args: unknown[]): void {
    console.error(`[${this.prefix}] ${message}`, ...args);
  }
  error(message: string, ...args: unknown[]): void {
    console.error(`[${this.prefix}] ${message}`, ...args);
  }
}

type ErrorCode =
  | "AUTH_REQUIRED"
  | "AUTH_CONFLICT"
  | "COMMAND_NOT_FOUND"
  | "ENV_UNSUPPORTED"
  | "FLAG_INVALID"
  | "FLAG_REQUIRED"
  | "INPUT_INVALID"
  | "RECEIPT_INVALID"
  | "SESSION_INVALID"
  | "SESSION_NOT_FOUND"
  | "NETWORK_ERROR"
  | "RATE_LIMITED"
  | "API_UNAVAILABLE"
  | "API_REJECTED"
  | "AUTH_INVALID"
  | "ENCRYPTION_FAILED"
  | "INTERNAL_ERROR"
  | "RECEIPT_PENDING"
  | "RECEIPT_EXPIRED"
  | "SESSION_FINALIZED"
  | "SESSION_LOCKED";



interface AppErrorOptions {
  code: ErrorCode;
  message: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
}

class AppError extends Error {
  code: ErrorCode;
  retryable: boolean;
  details?: Record<string, unknown>;

  constructor(options: AppErrorOptions) {
    super(options.message);
    this.code = options.code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

interface NextStep {
  command: string[];
  requiredFlags?: string[];
  optionalFlags?: string[];
  hint?: string;
}

interface SubmitOptions {
  apiKey: string | null;
  accessToken: string | null;
  env: string;
  endpoint: string | null;
  downloadBaseUrl: string | null;
  receiptPath: string | null;
  matchBy: string | null;
  matchValue: string | null;
  timeoutSeconds: number;
  verbose: boolean;
}

interface AuthOptions {
  apiKey: string | null;
  accessToken: string | null;
  env: string;
  endpoint: string | null;
  downloadBaseUrl: string | null;
  timeoutSeconds: number;
  verbose: boolean;
}

interface SubmitDownloadOptions extends AuthOptions {
  receiptPath: string | null;
  paymentType: string;
}

interface Session {
  version: 1 | 2;
  id: string;
  createdAt: string;
  updatedAt: string;
  auth: {
    env: string;
    endpoint: string | null;
  };
  identificationDetails: Record<string, unknown> | null;
  matchResponse: Record<string, unknown> | null;
  receipt: Record<string, unknown>;
  issue?: {
    state: "DRAFT" | ReceiptResult["state"];
    matchId?: string | null;
    cheqiReceiptId?: string | null;
    downloadId?: string | null;
    retryAfterSeconds?: number | null;
    payload?: ReceiptPayload;
    result?: Record<string, unknown>;
    updatedAt: string;
  };
}

async function main(args: string[]): Promise<void> {
  const startedAt = Date.now();
  try {
    const data = await route(args);
    if (args[0] === "skill" && args.includes("--raw") && isRecord(data) && typeof data.content === "string") {
      process.stdout.write((data as { content: string }).content);
      return;
    }
    printEnvelope(true, data, {
      durationMs: Date.now() - startedAt,
      version: VERSION
    });
  } catch (error) {
    const appError = normalizeError(error);
    printEnvelope(false, null, {
      durationMs: Date.now() - startedAt,
      version: VERSION
    }, appError);
    process.exitCode = ERROR_DEFINITIONS.find((entry) => entry.code === appError.code)?.exitCode ?? 1;
  }
}

async function route(args: string[]): Promise<unknown> {
  if (args.length === 0) {
    return commandSchema();
  }

  const [command, ...rest] = args;
  switch (command) {
    case "session":
      return sessionCommand(rest);
    case "receipt":
      return receiptCommand(rest);
    case "receipts":
      return receiptsCommand(rest);
    case "schema":
      return schemaCommand(rest);
    case "skill":
      return skillCommand(rest);
    case "version":
      activeCommandPath = ["version"];
      if (isHelp(rest)) return commandSchema(activeCommandPath);
      parseArgs(activeCommandPath, rest);
      return { version: VERSION };
    case "help":
    case "-h":
    case "--help":
      activeCommandPath = ["help"];
      if (isHelp(rest)) return commandSchema();
      if (rest.length) parseArgs(activeCommandPath, rest);
      return commandSchema();
    default:
      throw new AppError({
        code: "COMMAND_NOT_FOUND",
        message: `Unknown command: ${command}`,
        details: { command }
      });
  }
}

async function sessionCommand(args: string[]): Promise<unknown> {
  const [command, ...rest] = args;
  activeCommandPath = ["session", command ?? ""];
  switch (command) {
    case "create":
      if (isHelp(rest)) return commandSchema(["session", "create"]);
      return withSessionLock(rest, createSession);
    case "match":
      if (isHelp(rest)) return commandSchema(["session", "match"]);
      return withSessionLock(rest, matchSession);
    case "status":
      if (isHelp(rest)) return commandSchema(["session", "status"]);
      return statusSession(rest);
    case "reset":
      if (isHelp(rest)) return commandSchema(["session", "reset"]);
      return withSessionLock(rest, resetSession);
    case "help":
    case "-h":
    case "--help":
    case undefined:
      return commandSchema(["session"]);
    default:
      throw new AppError({
        code: "COMMAND_NOT_FOUND",
        message: `Unknown session command: ${command}`,
        details: { command }
      });
  }
}

async function receiptCommand(args: string[]): Promise<unknown> {
  const [command, ...rest] = args;
  activeCommandPath = ["receipt", command ?? ""];
  switch (command) {
    case "set":
      if (isHelp(rest)) return commandSchema(["receipt", "set"]);
      return withSessionLock(rest, setReceipt);
    case "add-product":
      if (isHelp(rest)) return commandSchema(["receipt", "add-product"]);
      return withSessionLock(rest, addProduct);
    case "remove-product":
      if (isHelp(rest)) return commandSchema(["receipt", "remove-product"]);
      return withSessionLock(rest, removeProduct);
    case "list-products":
      if (isHelp(rest)) return commandSchema(["receipt", "list-products"]);
      return listProducts(rest);
    case "preview":
      if (isHelp(rest)) return commandSchema(["receipt", "preview"]);
      return previewSession(rest);
    case "validate":
      if (isHelp(rest)) return commandSchema(["receipt", "validate"]);
      return validateSession(rest);
    case "finalize":
      if (isHelp(rest)) return commandSchema(["receipt", "finalize"]);
      return withSessionLock(rest, finalizeSession);
    case "help":
    case "-h":
    case "--help":
    case undefined:
      return commandSchema(["receipt"]);
    default:
      throw new AppError({
        code: "COMMAND_NOT_FOUND",
        message: `Unknown receipt command: ${command}`,
        details: { command }
      });
  }
}

async function receiptsCommand(args: string[]): Promise<unknown> {
  const [command, ...rest] = args;
  activeCommandPath = ["receipts", command ?? ""];
  switch (command) {
    case "submit":
      if (isHelp(rest)) return commandSchema(["receipts", "submit"]);
      return submitReceipt(rest);
    case "submit-download":
      if (isHelp(rest)) return commandSchema(["receipts", "submit-download"]);
      return submitDownloadReceipt(rest);
    case "resume":
      if (isHelp(rest)) return commandSchema(["receipts", "resume"]);
      return resumeDirectReceipt(rest);
    case "validate":
      if (isHelp(rest)) return commandSchema(["receipts", "validate"]);
      return validateDirectReceipt(rest);
    case "help":
    case "-h":
    case "--help":
    case undefined:
      return commandSchema(["receipts"]);
    default:
      throw new AppError({
        code: "COMMAND_NOT_FOUND",
        message: `Unknown receipts command: ${command}`,
        details: { command }
      });
  }
}

async function schemaCommand(args: string[]): Promise<unknown> {
  const path = args.filter((arg) => arg !== "--help" && arg !== "-h");
  if (path.some((part) => part.startsWith("-"))) throw new AppError({ code: "FLAG_INVALID", message: "Unknown schema flag",
    details: { flag: path.find((part) => part.startsWith("-")) } });
  return commandSchema(path);
}

async function skillCommand(args: string[]): Promise<unknown> {
  const [command, ...rest] = args;
  if (command === "install") {
    activeCommandPath = ["skill", "install"];
    if (isHelp(rest)) return commandSchema(activeCommandPath);
    const flags = parseArgs(activeCommandPath, rest);
    const target = resolve(stringFlag(flags, "dir") ?? ".claude/skills", "cheqi/SKILL.md");
    const content = await readFile(new URL("./cheqi/SKILL.md", import.meta.url), "utf8");
    let existing: string | null = null;
    try { existing = await readFile(target, "utf8"); }
    catch (error) { if (!isNodeError(error) || error.code !== "ENOENT") throw error; }
    const installedVersion = existing?.match(/^cli-version:\s*(\S+)/m)?.[1];
    if (installedVersion && compareVersions(installedVersion, VERSION) > 0 && !booleanFlag(flags, "force")) {
      throw new AppError({ code: "INPUT_INVALID", message: "Installed Cheqi skill is newer; use --force to replace it",
        details: { path: target, installedVersion, version: VERSION } });
    }
    await mkdir(resolve(target, ".."), { recursive: true });
    await writeFile(target, content, "utf8");
    return { path: target, version: VERSION };
  }
  activeCommandPath = ["skill"];
  if (isHelp(args)) return commandSchema(activeCommandPath);
  parseArgs(activeCommandPath, args);
  return { content: await readFile(new URL("./cheqi/SKILL.md", import.meta.url), "utf8"), version: VERSION };
}

function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number); const right = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) { if ((left[i] ?? 0) !== (right[i] ?? 0)) return (left[i] ?? 0) - (right[i] ?? 0); }
  return 0;
}

async function createSession(args: string[]): Promise<unknown> {
  const flags = parseArgs(activeCommandPath, args);
  const now = new Date().toISOString();
  const sessionId = requireSessionId(flags);
  const session: Session = {
    version: 2,
    id: sessionId,
    createdAt: now,
    updatedAt: now,
    auth: {
      env: stringFlag(flags, "env") ?? env("CHEQI_ENV") ?? "sandbox",
      endpoint: stringFlag(flags, "endpoint") ?? env("CHEQI_API_ENDPOINT")
    },
    identificationDetails: null,
    matchResponse: null,
    issue: { state: "DRAFT", updatedAt: now },
    receipt: {
      documentNumber: stringFlag(flags, "document-number") ?? `RECEIPT-${Date.now()}`,
      issueDate: parseIssueDate(stringFlag(flags, "issue-date") ?? "now"),
      currency: stringFlag(flags, "currency") ?? "EUR",
      receiptSubtotal: 0,
      totalBeforeTax: 0,
      totalTaxAmount: 0,
      totalAmount: 0,
      taxesApplied: false,
      products: [],
      taxes: []
    }
  };

  const match = identificationDetailsFromFlags(flags);
  if (match !== null) {
    session.identificationDetails = match as unknown as Record<string, unknown>;
  }

  await saveSession(session);
  return {
    sessionId: session.id,
    session: sessionPath(session.id),
    receipt: session.receipt,
    hasMatch: hasIdentificationDetails(session),
    nextStep: hasIdentificationDetails(session)
      ? nextStep(["receipt", "add-product"], ["session", "name"], ["price-incl", "unit-price", "vat"], "Add at least one product before validation or finalization.")
      : nextStep(["session", "match"], ["session"], ["card-par", "pairing-code", "payment-account-identifier", "email", "payment-type"], "Match the customer before finalizing the receipt.")
  };
}

async function matchSession(args: string[]): Promise<unknown> {
  const flags = parseArgs(activeCommandPath, args);
  const auth = parseAuthOptions(args);
  validateAuth(auth);

  const identificationDetails = identificationDetailsFromFlags(flags);
  if (identificationDetails === null) {
    throw new AppError({
      code: "FLAG_REQUIRED",
      message: "Provide one match flag: --card-par, --pairing-code, --payment-account-identifier, --email, or --payment-type",
      details: { flags: ["card-par", "pairing-code", "payment-account-identifier", "email", "payment-type"] }
    });
  }

  const session = await loadSession(requireSessionId(flags));
  session.identificationDetails = identificationDetails as unknown as Record<string, unknown>;
  session.auth.env = auth.env;
  session.auth.endpoint = auth.endpoint;

  const sdk = buildSDK(auth);
  session.matchResponse = await sdk.matchingService.matchCustomer(
    identificationDetails,
    auth.accessToken
  ) as unknown as Record<string, unknown>;
  touch(session);
  await saveSession(session);

  return {
    sessionId: session.id,
    session: sessionPath(session.id),
    routeFound: session.matchResponse?.routeFound ?? false,
    deliveryRouteType: session.matchResponse?.deliveryRouteType,
    matchId: session.matchResponse?.matchId,
    expiresAt: session.matchResponse?.expiresAt,
    recipientCount: Array.isArray(session.matchResponse?.recipients) ? session.matchResponse.recipients.length : 0,
    nextStep: nextStep(["receipt", "add-product"], ["session", "name"], ["price-incl", "unit-price", "vat"], "Add product lines before validation or finalization.")
  };
}

async function setReceipt(args: string[]): Promise<unknown> {
  const flags = parseArgs(activeCommandPath, args);
  const session = await loadSession(requireSessionId(flags));
  assertDraft(session);
  const receipt = session.receipt;

  setIfPresent(receipt, "documentNumber", stringFlag(flags, "document-number"));
  setIfPresent(receipt, "currency", stringFlag(flags, "currency"));
  const issueDate = stringFlag(flags, "issue-date");
  if (issueDate) {
    receipt.issueDate = parseIssueDate(issueDate);
  }
  setIfPresent(receipt, "note", stringFlag(flags, "note"));

  if (session.issue) session.issue.payload = undefined;
  touch(session);
  await saveSession(session);
  return {
    sessionId: session.id,
    session: sessionPath(session.id),
    receipt,
    nextStep: nextStep(["receipt", "add-product"], ["session", "name"], ["price-incl", "unit-price", "vat"])
  };
}

async function addProduct(args: string[]): Promise<unknown> {
  const flags = parseArgs(activeCommandPath, args);
  const positionalName = flags._[0];
  const name = stringFlag(flags, "name") ?? positionalName;
  if (!name) {
    throw new AppError({
      code: "FLAG_REQUIRED",
      message: "Product name is required. Use --name \"Nike Shoes\" or pass the name as the first argument.",
      details: { flag: "name" }
    });
  }

  const quantity = numberFlag(flags, "quantity") ?? 1;
  if (quantity <= 0) throw new AppError({ code: "FLAG_INVALID", message: "--quantity must be greater than zero",
    details: { flag: "quantity", value: quantity } });
  const vatRate = numberFlag(flags, "vat") ?? 0;
  const taxType = stringFlag(flags, "tax-type") ?? "VAT";
  const unitCode = stringFlag(flags, "unit-code") ?? "C62";
  const brandName = stringFlag(flags, "brand") ?? "";
  const identifier = stringFlag(flags, "identifier");

  const priceIncl = numberFlag(flags, "price-incl");
  const unitPrice = numberFlag(flags, "unit-price");

  if (priceIncl === undefined && unitPrice === undefined) {
    throw new AppError({
      code: "FLAG_REQUIRED",
      message: "Provide --price-incl or --unit-price",
      details: { flags: ["price-incl", "unit-price"] }
    });
  }

  const netUnitPrice = unitPrice ?? roundMoney((priceIncl as number) / (1 + vatRate / 100));
  const subtotal = roundMoney(netUnitPrice * quantity);
  const taxAmount = roundMoney(subtotal * (vatRate / 100));
  const total = priceIncl !== undefined ? roundMoney(priceIncl * quantity) : roundMoney(subtotal + taxAmount);
  const tax = {
    rate: vatRate,
    type: taxType,
    taxableAmount: subtotal,
    amount: taxAmount,
    label: stringFlag(flags, "tax-label") ?? taxType
  };

  const session = await loadSession(requireSessionId(flags));
  assertDraft(session);
  const products = Array.isArray(session.receipt.products) ? session.receipt.products : [];
  const product = {
    name,
    brandName,
    identifier: identifier ?? `LINE-${products.length + 1}`,
    quantity,
    unitCode,
    unitPrice: netUnitPrice,
    taxes: [tax],
    subtotal,
    total
  };

  products.push(product);
  session.receipt.products = products;
  recomputeTotals(session.receipt);

  if (session.issue) session.issue.payload = undefined;
  touch(session);
  await saveSession(session);
  return {
    sessionId: session.id,
    session: sessionPath(session.id),
    added: product,
    totals: totals(session.receipt),
    nextStep: nextStep(["receipt", "validate"], ["session"], [], "Validate locally before finalizing.")
  };
}

async function removeProduct(args: string[]): Promise<unknown> {
  const flags = parseArgs(activeCommandPath, args);
  const session = await loadSession(requireSessionId(flags));
  assertDraft(session);
  const line = stringFlag(flags, "line") as string;
  const products = Array.isArray(session.receipt.products) ? session.receipt.products : [];
  const numericIndex = /^[1-9][0-9]*$/.test(line) ? Number(line) - 1 : -1;
  const index = numericIndex >= 0 ? numericIndex : products.findIndex((product) => isRecord(product) && product.identifier === line);
  if (index < 0 || index >= products.length) throw new AppError({ code: "INPUT_INVALID", message: "Product line not found", details: { line } });
  const [removed] = products.splice(index, 1);
  session.receipt.products = products;
  recomputeTotals(session.receipt);
  if (session.issue) session.issue.payload = undefined;
  touch(session);
  await saveSession(session);
  return { sessionId: session.id, session: sessionPath(session.id), removed, totals: totals(session.receipt),
    nextStep: nextStep(["receipt", "list-products"], ["session"]) };
}

async function listProducts(args: string[]): Promise<unknown> {
  const flags = parseArgs(activeCommandPath, args);
  const session = await loadSession(requireSessionId(flags));
  return { sessionId: session.id, session: sessionPath(session.id), products: session.receipt.products ?? [],
    totals: totals(session.receipt), nextStep: statusNextStep(session) };
}

async function previewSession(args: string[]): Promise<unknown> {
  const session = await loadSession(requireSessionId(parseArgs(activeCommandPath, args)));
  recomputeTotals(session.receipt);
  return {
    session: sessionPath(session.id),
    draft: session,
    nextStep: nextStep(["receipt", "validate"], ["session"], [], "Validate locally before finalizing.")
  };
}

async function statusSession(args: string[]): Promise<unknown> {
  const session = await loadSession(requireSessionId(parseArgs(activeCommandPath, args)));
  return {
    sessionId: session.id,
    session: sessionPath(session.id),
    hasMatch: hasIdentificationDetails(session),
    hasMatchResponse: Boolean(session.matchResponse),
    productCount: Array.isArray(session.receipt.products) ? session.receipt.products.length : 0,
    totals: totals(session.receipt),
    updatedAt: session.updatedAt,
    issueState: issueState(session),
    nextStep: statusNextStep(session)
  };
}

async function validateSession(args: string[]): Promise<unknown> {
  const session = await loadSession(requireSessionId(parseArgs(activeCommandPath, args)));
  recomputeTotals(session.receipt);
  validateReadyToFinalize(session);
  return {
    valid: true,
    sessionId: session.id,
    session: sessionPath(session.id),
    totals: totals(session.receipt),
    nextStep: nextStep(["receipt", "finalize"], ["session"], ["api-key", "access-token", "env", "endpoint", "timeout"], "Finalize only after local validation succeeds.")
  };
}

async function finalizeSession(args: string[]): Promise<unknown> {
  const auth = parseAuthOptions(args);
  const flags = parseArgs(activeCommandPath, args);
  const session = await loadSession(requireSessionId(flags));
  const state = issueState(session);
  if (["DIGITAL_SUBMITTED", "DOWNLOAD_FALLBACK", "EMAIL_FALLBACK"].includes(state)
      && !(state === "DOWNLOAD_FALLBACK" && session.issue?.result?.retryable === true)) {
    const sidecar = state === "DOWNLOAD_FALLBACK" ? await loadDownloadSidecar(session.id) : null;
    return { ...session.issue?.result, ...(sidecar ? { downloadUrl: sidecar.downloadUrl } : {}),
      alreadyFinalized: true, sessionId: session.id, session: sessionPath(session.id) };
  }
  const fallbackRequested = stringFlag(flags, "fallback") === "download";
  if (fallbackRequested && state !== "DIGITAL_EXPIRED" && !(state === "DOWNLOAD_FALLBACK" && session.issue?.result?.retryable === true)) {
    throw new AppError({ code: "FLAG_INVALID", message: "--fallback download requires an expired digital match or an uncertain download upload",
      details: { flag: "fallback", state } });
  }
  validateAuth(auth);
  if (state === "DIGITAL_EXPIRED" && !fallbackRequested) {
    throw expiredReceipt(session.id);
  }
  if (state === "DRAFT") {
    recomputeTotals(session.receipt);
    validateReadyToFinalize(session);
    session.issue = { state: "DRAFT", payload: session.issue?.payload ?? definitiveReceipt(session.receipt), updatedAt: new Date().toISOString() };
    session.version = 2;
    await saveSession(session);
  }

  const sdk = buildSDK({
    ...auth,
    env: stringFlag(flags, "env") ?? session.auth.env ?? auth.env,
    endpoint: stringFlag(flags, "endpoint") ?? session.auth.endpoint ?? auth.endpoint
  });

  if (fallbackRequested || (state === "DOWNLOAD_FALLBACK" && session.issue?.result?.retryable === true)) {
    const prepared = await loadPreparedDownload(session.id);
    if (!prepared) throw new AppError({ code: "INPUT_INVALID", message: "No prepared download is saved for this session",
      details: { sessionId: session.id, state } });
    const uploaded = await sdk.receiptService.uploadPreparedDownload(prepared, auth.accessToken);
    const data = { success: true, accepted: true, state: "DOWNLOAD_FALLBACK", retryable: false,
      matchId: session.issue?.matchId, cheqiReceiptId: uploaded.cheqiReceiptId,
      downloadUrl: prepared.downloadUrl, downloadId: prepared.uploadRequest.downloadId,
      deliveryRouteType: "DOWNLOAD_FALLBACK" };
    session.issue = { ...session.issue!, state: "DOWNLOAD_FALLBACK", cheqiReceiptId: uploaded.cheqiReceiptId,
      result: withoutSecret(data), updatedAt: new Date().toISOString() };
    await saveSession(session);
    return { ...data, sessionId: session.id, session: sessionPath(session.id) };
  }
  const payload = session.issue?.payload;
  if (!payload) throw new AppError({ code: "SESSION_INVALID", message: "Session has no saved receipt payload" });
  const result = state === "DIGITAL_PENDING"
    ? await sdk.receiptService.resumeReceipt(session.issue?.matchId as string, payload, { accessToken: auth.accessToken })
    : await sdk.receiptService.issueReceipt(session.identificationDetails as unknown as IdentificationDetails, payload, { accessToken: auth.accessToken });
  if (state === "DRAFT" && result.state === "DOWNLOAD_FALLBACK" && result.retryable && !lastMatchSucceeded) {
    await rm(downloadSidecarPath(session.id), { force: true });
    throw new AppError({ code: "NETWORK_ERROR", message: "Customer matching failed; retry finalize",
      retryable: true, details: { sessionId: session.id, state: "DRAFT",
        nextStep: nextStep(["receipt", "finalize"], ["session"], [], "Retry matching with the saved receipt payload.") } });
  }
  if (result.preparedDownload) await saveDownloadSidecar(session.id, result.preparedDownload);
  else if (result.downloadUrl) await saveDownloadSidecar(session.id, { downloadUrl: result.downloadUrl });
  const data = receiptResultData(result);
  session.issue = { ...session.issue!, state: result.state, matchId: result.matchId,
    cheqiReceiptId: result.cheqiReceiptId, downloadId: typeof data.downloadId === "string" ? data.downloadId : undefined,
    retryAfterSeconds: result.retryAfterSeconds, result: withoutSecret(data), updatedAt: new Date().toISOString() };
  await saveSession(session);
  if (result.state === "DIGITAL_SUBMITTED") await rm(downloadSidecarPath(session.id), { force: true });
  if (result.state === "DIGITAL_PENDING") throw pendingReceipt(result, ["receipt", "finalize"], session.id);
  if (result.state === "DIGITAL_EXPIRED") throw expiredReceipt(session.id);
  if (result.retryable && !result.isSuccess()) throw uncertainUploadError(result.state, session.id);

  return {
    ...data,
    sessionId: session.id,
    session: sessionPath(session.id)
  };
}

async function resetSession(args: string[]): Promise<unknown> {
  const sessionId = requireSessionId(parseArgs(activeCommandPath, args));
  await rm(sessionPath(sessionId), { force: true });
  await rm(downloadSidecarPath(sessionId), { force: true });
  return { sessionId, session: sessionPath(sessionId), reset: true };
}

async function submitReceipt(args: string[]): Promise<unknown> {
  const options = parseSubmitOptions(args);
  validateSubmitOptions(options);

  const sdk = buildSDK(options);
  const receipt = definitiveReceipt(await readReceipt(options.receiptPath as string));
  const identificationDetails = buildIdentificationDetails(
    options.matchBy as string,
    options.matchValue as string
  );

  const result = await sdk.receiptService.issueReceipt(
    identificationDetails,
    receipt,
    { accessToken: options.accessToken }
  );
  if (result.state === "DOWNLOAD_FALLBACK" && result.retryable && !lastMatchSucceeded) {
    throw new AppError({ code: "NETWORK_ERROR", message: "Customer matching failed; retry the original submission",
      retryable: true, details: { nextStep: nextStep(["receipts", "submit"], ["receipt", "match-by", "match-value"], [],
        "Retry matching with exactly the original receipt payload and customer identifier.") } });
  }
  if (result.state === "DIGITAL_PENDING") throw pendingReceipt(result, ["receipts", "resume"]);
  if (result.state === "DIGITAL_EXPIRED") throw expiredReceipt();
  if (result.retryable && !result.isSuccess()) throw uncertainUploadError(result.state);
  return receiptResultData(result);
}

async function validateDirectReceipt(args: string[]): Promise<unknown> {
  const flags = parseArgs(activeCommandPath, args);
  const receipt = definitiveReceipt(await readReceipt(stringFlag(flags, "receipt") as string));
  return { valid: true, totals: totals(receipt as unknown as Record<string, unknown>) };
}

async function resumeDirectReceipt(args: string[]): Promise<unknown> {
  const flags = parseArgs(activeCommandPath, args);
  const matchId = stringFlag(flags, "match-id");
  const path = stringFlag(flags, "receipt");
  if (!matchId) throw requiredFlag("match-id");
  if (!path) throw requiredFlag("receipt");
  const auth = parseAuthOptions(args);
  validateAuth(auth);
  const sdk = buildSDK(auth);
  const payload = definitiveReceipt(await readReceipt(path));
  const result = await sdk.receiptService.resumeReceipt(matchId, payload, { accessToken: auth.accessToken });
  if (result.state === "DIGITAL_PENDING") throw pendingReceipt(result, ["receipts", "resume"]);
  if (result.state === "DIGITAL_EXPIRED") throw expiredReceipt();
  if (result.retryable && !result.isSuccess()) throw uncertainUploadError(result.state);
  return receiptResultData(result);
}

function issueState(session: Session): "DRAFT" | ReceiptResult["state"] {
  return session.issue?.state ?? "DRAFT";
}

function assertDraft(session: Session): void {
  if (issueState(session) !== "DRAFT") {
    throw new AppError({ code: "SESSION_FINALIZED", message: "The receipt payload is frozen after finalization starts",
      details: { state: issueState(session) } });
  }
}

function pendingReceipt(result: ReceiptResult, command: string[], sessionId?: string): AppError {
  return new AppError({ code: "RECEIPT_PENDING", message: "Receipt submission is pending; resume the original match",
    retryable: true, details: { state: result.state, matchId: result.matchId,
      ...(result.retryAfterSeconds !== null ? { retryAfterSeconds: result.retryAfterSeconds } : {}),
      nextStep: nextStep(command, sessionId ? ["session"] : ["match-id", "receipt"], [], "Retry after retryAfterSeconds when provided."),
      ...(sessionId ? { sessionId } : {}) } });
}

function expiredReceipt(sessionId?: string): AppError {
  return new AppError({ code: "RECEIPT_EXPIRED", message: "The original digital match expired",
    details: sessionId
      ? { sessionId, nextStep: nextStep(["receipt", "finalize"], ["session", "fallback"], [], "Use --fallback download for the prepared download.") }
      : { hint: "This direct flow has no saved download fallback. Check the original outcome before starting a new receipt." } });
}

function uncertainUploadError(state: string, sessionId?: string): AppError {
  return new AppError({ code: "NETWORK_ERROR", message: "Receipt upload is uncertain", retryable: true,
    details: { state, ...(sessionId ? {
      sessionId,
      nextStep: nextStep(["receipt", "finalize"], ["session"], [], "Retry the saved prepared download upload.")
    } : {
      nextStep: nextStep(["receipts", "validate"], ["receipt"], [],
        "Confirm whether the first upload succeeded before issuing again; the direct flow has no saved upload.")
    }) } });
}

function withoutSecret(data: Record<string, unknown>): Record<string, unknown> {
  const { downloadUrl: _url, preparedDownload: _prepared, ...safe } = data;
  return safe;
}

function downloadSidecarPath(sessionId: string): string {
  return resolve(sessionsDir, `${sessionId}.download.json`);
}

async function saveDownloadSidecar(sessionId: string, prepared: { downloadUrl: string; uploadRequest?: PreparedReceiptDownload["uploadRequest"] }): Promise<void> {
  await mkdir(sessionsDir, { recursive: true });
  const target = downloadSidecarPath(sessionId);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(prepared), { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, target);
}

async function loadDownloadSidecar(sessionId: string): Promise<{ downloadUrl: string; uploadRequest?: PreparedReceiptDownload["uploadRequest"] } | null> {
  try { return JSON.parse(await readFile(downloadSidecarPath(sessionId), "utf8")) as PreparedReceiptDownload; }
  catch (error) { if (isNodeError(error) && error.code === "ENOENT") return null; throw error; }
}

async function loadPreparedDownload(sessionId: string): Promise<PreparedReceiptDownload | null> {
  const sidecar = await loadDownloadSidecar(sessionId);
  return sidecar?.uploadRequest ? sidecar as PreparedReceiptDownload : null;
}

async function withSessionLock(args: string[], handler: (args: string[]) => Promise<unknown>): Promise<unknown> {
  const flags = parseArgs(activeCommandPath, args);
  const id = requireSessionId(flags);
  await mkdir(sessionsDir, { recursive: true });
  const lockPath = `${sessionPath(id)}.lock`;
  const deadline = Date.now() + 5000;
  const staleAfterMs = 60_000;
  const heartbeatEveryMs = 5_000;
  const owner = randomUUID();
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  while (!handle) {
    try { handle = await open(lockPath, "wx", 0o600); }
    catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      try {
        const stale = await stat(lockPath);
        if (Date.now() - stale.mtimeMs > staleAfterMs) {
          const current = await stat(lockPath);
          if (current.ino === stale.ino && current.mtimeMs === stale.mtimeMs && Date.now() - current.mtimeMs > staleAfterMs) {
            await rm(lockPath, { force: true });
            continue;
          }
        }
      } catch (statError) { if (!isNodeError(statError) || statError.code !== "ENOENT") throw statError; }
      if (Date.now() >= deadline) throw new AppError({ code: "SESSION_LOCKED", message: "Session is busy; retry shortly", retryable: true,
        details: { sessionId: id } });
      await new Promise((done) => setTimeout(done, 30 + Math.floor(Math.random() * 40)));
    }
  }
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let pulse: Promise<void> = Promise.resolve();
  try {
    await handle.writeFile(JSON.stringify({ owner, pid: process.pid }));
    heartbeat = setInterval(() => {
      pulse = handle.utimes(new Date(), new Date());
      void pulse.catch(() => undefined);
    }, heartbeatEveryMs);
    heartbeat.unref();
    return await handler(args);
  }
  finally {
    if (heartbeat) clearInterval(heartbeat);
    await pulse.catch(() => undefined);
    await handle.close();
    try {
      const current = JSON.parse(await readFile(lockPath, "utf8")) as Record<string, unknown>;
      if (current.owner === owner) await rm(lockPath, { force: true });
    } catch (error) { if (!isNodeError(error) || error.code !== "ENOENT") throw error; }
  }
}

// Public receipt-download page per environment (Download Link Contract v1).
const DOWNLOAD_BASE_URLS: Record<string, string> = {
  sandbox: "https://sandbox.receipt.cheqi.io",
  test: "https://test.receipt.cheqi.io",
  production: "https://receipt.cheqi.io",
  prod: "https://receipt.cheqi.io"
};

function resolveDownloadBaseUrl(options: Pick<SubmitDownloadOptions, "downloadBaseUrl" | "env">): string {
  if (options.downloadBaseUrl) {
    return options.downloadBaseUrl;
  }
  const baseUrl = DOWNLOAD_BASE_URLS[normalize(options.env)];
  if (!baseUrl) {
    throw new AppError({
      code: "ENV_UNSUPPORTED",
      message: `No receipt download base URL for environment: ${options.env}. Pass --download-base-url.`,
      details: { env: options.env, supported: ["sandbox", "test", "production"] }
    });
  }
  return baseUrl;
}

function receiptResultData(result: ReceiptResult): Record<string, unknown> {
  const downloadId = result.downloadUrl ? parseDownloadUrl(result.downloadUrl).downloadId : undefined;
  return {
    success: result.isSuccess(),
    accepted: result.isAccepted(),
    state: result.state,
    retryable: result.retryable,
    retryAfterSeconds: result.retryAfterSeconds ?? undefined,
    preparedDownload: result.preparedDownload ?? undefined,
    cheqiReceiptId: result.cheqiReceiptId ?? undefined,
    matchId: result.matchId ?? undefined,
    deliveryRouteType: result.deliveryRouteType,
    status: result.status ?? undefined,
    createdAt: result.createdAt ?? undefined,
    expiresAt: result.expiresAt ?? undefined,
    downloadUrl: result.downloadUrl ?? undefined,
    downloadId,
    downloadEnvelopeRequired: result.downloadEnvelopeRequired,
    emailReceiptRequired: result.emailReceiptRequired
  };
}

/**
 * Issues a receipt via a client-generated, end-to-end-encrypted download link
 * (Download Link Contract v1): the download id and AES key are generated locally, the
 * envelope is encrypted client-side, and the server stores ciphertext it can never
 * decrypt. No customer matching is involved. The returned downloadUrl carries the key
 * in its #fragment — hand it to the customer (QR); do not log it server-side.
 */
async function submitDownloadReceipt(args: string[]): Promise<unknown> {
  const options = parseSubmitDownloadOptions(args);
  if (!options.receiptPath) {
    throw requiredFlag("receipt");
  }
  validateAuth(options);

  const sdk = buildSDK(options);
  const receipt = definitiveReceipt(await readReceipt(options.receiptPath));
  const result = await sdk.receiptService.issueDownloadReceipt(
    { paymentType: options.paymentType as IdentificationDetails["paymentType"] },
    receipt,
    options.accessToken
  );
  if (result.retryable && !result.isSuccess()) throw uncertainUploadError(result.state);
  return receiptResultData(result);
}

function parseSubmitDownloadOptions(args: string[]): SubmitDownloadOptions {
  const flags = parseArgs(activeCommandPath, args);
  return { ...authFromFlags(flags), receiptPath: stringFlag(flags, "receipt"),
    paymentType: stringFlag(flags, "payment-type") ?? "CASH" };
}

function commandSchema(path: string[] = []): unknown {
  const selected = path.length === 0
    ? commands
    : commands.filter((command) => path.every((part, index) => command.command[index] === part));

  if (selected.length === 0) {
    throw new AppError({
      code: "COMMAND_NOT_FOUND",
      message: `No schema found for: ${path.join(" ")}`,
      details: { command: path }
    });
  }

  return {
    version: VERSION,
    envelope: {
      success: { ok: true, data: {}, meta: { durationMs: 0, version: VERSION } },
      failure: {
        ok: false,
        error: { code: "ERROR_CODE", message: "Human-readable message", retryable: false, details: {} },
        meta: { durationMs: 0, version: VERSION }
      }
    },
    commands: selected,
    errors: ERROR_DEFINITIONS
  };
}


function parseSubmitOptions(args: string[]): SubmitOptions {
  const flags = parseArgs(activeCommandPath, args);
  return { ...authFromFlags(flags), receiptPath: stringFlag(flags, "receipt"),
    matchBy: stringFlag(flags, "match-by"), matchValue: stringFlag(flags, "match-value") ?? (flags["match-value"] === "" ? "" : null) };
}

function validateSubmitOptions(options: SubmitOptions): void {
  if (!options.receiptPath) {
    throw requiredFlag("receipt");
  }
  if (!options.matchBy) {
    throw requiredFlag("match-by");
  }
  if (options.matchValue === null) {
    throw requiredFlag("match-value");
  }
  validateAuth(options);
}

function parseAuthOptions(args: string[]): AuthOptions {
  const flags = parseArgs(activeCommandPath, args);
  return authFromFlags(flags);
}

function authFromFlags(flags: Flags): AuthOptions {
  return {
    apiKey: stringFlag(flags, "api-key") ?? env("CHEQI_API_KEY"),
    accessToken: stringFlag(flags, "access-token") ?? env("CHEQI_ACCESS_TOKEN"),
    env: stringFlag(flags, "env") ?? env("CHEQI_ENV") ?? "sandbox",
    endpoint: stringFlag(flags, "endpoint") ?? env("CHEQI_API_ENDPOINT"),
    downloadBaseUrl: stringFlag(flags, "download-base-url") ?? env("CHEQI_DOWNLOAD_BASE_URL"),
    timeoutSeconds: parsePositiveInt(stringFlag(flags, "timeout") ?? env("CHEQI_TIMEOUT_SECONDS"), 30),
    verbose: booleanFlag(flags, "verbose")
  };
}

function validateAuth(options: Pick<AuthOptions, "apiKey" | "accessToken">): void {
  if (!options.apiKey && !options.accessToken) {
    throw new AppError({
      code: "AUTH_REQUIRED",
      message: "Set --api-key, --access-token, CHEQI_API_KEY, or CHEQI_ACCESS_TOKEN"
    });
  }
  if (options.apiKey && options.accessToken) {
    throw new AppError({
      code: "AUTH_CONFLICT",
      message: "Use either API key authentication or access token authentication, not both"
    });
  }
}

function buildSDK(options: AuthOptions): CheqiSDK {
  lastRetryAfterSeconds = undefined;
  lastMatchSucceeded = false;
  return new CheqiSDK({
    apiEndpoint: resolveEndpoint(options),
    apiKey: options.apiKey,
    receiptDownloadBaseUrl: options.downloadBaseUrl ?? resolveDownloadBaseUrl(options),
    timeoutSeconds: options.timeoutSeconds,
    logger: options.verbose ? new StderrLogger() : new NoopLogger(),
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      if (new URL(String(input)).pathname.endsWith("/recipient/resolve") && response.ok) lastMatchSucceeded = true;
      if (response.status === 429) {
        const retryAfter = response.headers.get("retry-after");
        const seconds = retryAfter === null ? NaN : Number(retryAfter);
        lastRetryAfterSeconds = Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
      }
      return response;
    }
  });
}

function resolveEndpoint(options: Pick<AuthOptions, "endpoint" | "env">): string {
  if (options.endpoint) {
    return options.endpoint;
  }

  switch (normalize(options.env)) {
    case "sandbox":
      return Environment.SANDBOX;
    case "test":
      return Environment.TEST;
    case "production":
    case "prod":
      return Environment.PRODUCTION;
    default:
      throw new AppError({
        code: "ENV_UNSUPPORTED",
        message: `Unsupported environment: ${options.env}`,
        details: { env: options.env, supported: ["sandbox", "test", "production"] }
      });
  }
}

type Flags = Record<string, string | boolean | string[]> & { _: string[] };

interface FlagSchema { name: string; type: string; required: boolean; values?: string[]; aliases?: string[] }

function parseArgs(commandPath: string[], args: string[]): Flags {
  const selected = commandSchema(commandPath) as { commands: { flags: FlagSchema[]; positional: { name: string }[] }[] };
  const schema = selected.commands[0];
  const names = new Map<string, FlagSchema>();
  for (const flag of schema.flags) {
    names.set(flag.name, flag);
    for (const alias of flag.aliases ?? []) names.set(alias, flag);
  }
  const flags: Flags = { _: [] };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg.startsWith("--")) {
      const withoutPrefix = arg.slice(2);
      const equalsIndex = withoutPrefix.indexOf("=");
      const name = equalsIndex >= 0 ? withoutPrefix.slice(0, equalsIndex) : withoutPrefix;
      const spec = names.get(name);
      if (!spec) {
        const suggestion = [...names.keys()].map((known) => ({ known, distance: editDistance(name, known) }))
          .sort((a, b) => a.distance - b.distance)[0];
        throw new AppError({ code: "FLAG_INVALID", message: `Unknown flag --${name}`,
          details: { flag: name, ...(suggestion && suggestion.distance <= 2 ? { suggestion: suggestion.known } : {}) } });
      }
      if (Object.hasOwn(flags, spec.name)) throw new AppError({ code: "FLAG_INVALID", message: `Repeated flag --${spec.name}`, details: { flag: spec.name } });
      if (spec.type === "boolean") {
        if (equalsIndex >= 0) throw new AppError({ code: "FLAG_INVALID", message: `--${spec.name} takes no value`, details: { flag: spec.name } });
        flags[spec.name] = true;
        continue;
      }
      const value = equalsIndex >= 0 ? withoutPrefix.slice(equalsIndex + 1) : args[++index];
      if (value === undefined || value.startsWith("--")) throw requiredFlag(spec.name);
      if (spec.type === "number" && !Number.isFinite(Number(value.replace(",", ".")))) {
        throw new AppError({ code: "FLAG_INVALID", message: `--${spec.name} must be a number`, details: { flag: spec.name, value } });
      }
      if (spec.type === "enum") {
        const canonical = spec.values?.find((candidate) => candidate.toLowerCase() === value.toLowerCase());
        if (!canonical) throw new AppError({ code: "FLAG_INVALID", message: `Invalid value for --${spec.name}`, details: { flag: spec.name, value, values: spec.values } });
        flags[spec.name] = canonical;
      } else flags[spec.name] = value;
      continue;
    }
    flags._.push(arg);
  }
  if (flags._.length > schema.positional.length) throw new AppError({ code: "INPUT_INVALID", message: "Too many positional arguments" });
  const missing = schema.flags.filter((flag) => flag.required && !Object.hasOwn(flags, flag.name)).map((flag) => flag.name);
  if (missing.length) throw new AppError({ code: "FLAG_REQUIRED", message: `Missing required flags: ${missing.map((name) => `--${name}`).join(", ")}`, details: { flags: missing } });
  const customSessionsDir = stringFlag(flags, "sessions-dir");
  sessionsDir = resolve(customSessionsDir ?? process.env.CHEQI_SESSIONS_DIR ?? SESSIONS_DIR);
  return flags;
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const next = row[j]; row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1)); previous = next;
    }
  }
  return row[b.length];
}

function requireSessionId(flags: Flags): string {
  const sessionId = sessionIdFromFlags(flags);
  if (!sessionId) {
    throw requiredFlag("session");
  }
  return sessionId;
}

function sessionIdFromFlags(flags: Flags): string | null {
  return sanitizeSessionId(typeof flags.session === "string" ? flags.session : null);
}

function sanitizeSessionId(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) {
    throw new AppError({
      code: "SESSION_INVALID",
      message: "Invalid session id",
      details: { value, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$" }
    });
  }
  return value;
}

function sessionPath(sessionId: string): string {
  return resolve(sessionsDir, `${sessionId}.json`);
}

function stringFlag(flags: Flags, name: string): string | null {
  const value = flags[name];
  if (typeof value === "string" && value.trim() !== "") {
    return value.trim();
  }
  return null;
}

function numberFlag(flags: Flags, name: string): number | undefined {
  const value = stringFlag(flags, name);
  if (value === null) {
    return undefined;
  }
  const normalized = value.replace(",", ".");
  const parsed = Number.parseFloat(normalized);
  if (!Number.isFinite(parsed)) {
    throw new AppError({
      code: "FLAG_INVALID",
      message: `--${name} must be a number`,
      details: { flag: name, value }
    });
  }
  return parsed;
}

function booleanFlag(flags: Flags, name: string): boolean {
  return flags[name] === true || flags[name] === "true";
}

function identificationDetailsFromFlags(flags: Flags): IdentificationDetails | null {
  const cardPar = stringFlag(flags, "card-par");
  if (cardPar !== null) {
    return buildIdentificationDetails("card_par", cardPar);
  }

  const pairingCode = stringFlag(flags, "pairing-code");
  if (pairingCode !== null) {
    return buildIdentificationDetails("pairing_code", pairingCode);
  }

  const paymentAccountIdentifier = stringFlag(flags, "payment-account-identifier");
  if (paymentAccountIdentifier !== null) {
    return buildIdentificationDetails("payment_account_identifier", paymentAccountIdentifier);
  }

  const email = stringFlag(flags, "email");
  if (email !== null) {
    return buildIdentificationDetails("email", email);
  }

  const paymentType = stringFlag(flags, "payment-type");
  if (paymentType !== null) {
    return buildIdentificationDetails("payment_type", paymentType);
  }

  if (hasAnyFlag(flags, ["card-par"])) return buildIdentificationDetails("card_par", "");
  if (hasAnyFlag(flags, ["pairing-code"])) return buildIdentificationDetails("pairing_code", "");
  if (hasAnyFlag(flags, ["payment-account-identifier"])) {
    return buildIdentificationDetails("payment_account_identifier", "");
  }
  if (hasAnyFlag(flags, ["email"])) return buildIdentificationDetails("email", "");
  if (hasAnyFlag(flags, ["payment-type"])) {
    throw new AppError({
      code: "FLAG_REQUIRED",
      message: "--payment-type requires a value",
      details: { flag: "payment-type" }
    });
  }

  return null;
}

async function readReceipt(path: string): Promise<Record<string, unknown>> {
  let raw: string;
  try { raw = path === "-" ? await readStdin() : await readFile(path, "utf8"); }
  catch (error) {
    if (isNodeError(error) && ["ENOENT", "EISDIR", "EACCES"].includes(error.code as string)) {
      throw new AppError({ code: "INPUT_INVALID", message: "Receipt input could not be read", details: { path } });
    }
    throw error;
  }
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    throw new AppError({
      code: "INPUT_INVALID",
      message: "Receipt input must be valid JSON",
      details: { path, reason: error instanceof Error ? error.message : String(error) }
    });
  }
}

function definitiveReceipt(receipt: Record<string, unknown>): ReceiptPayload {
  const normalized: Record<string, unknown> = { ...receipt };
  for (const field of ["issueDate", "transactionDate", "purchaseDate"] as const) {
    if (normalized[field] !== undefined) {
      normalized[field] = receiptDate(normalized[field], field);
    }
  }
  if (isRecord(normalized.period)) {
    normalized.period = {
      ...normalized.period,
      startDate: receiptDate(normalized.period.startDate, "period.startDate"),
      endDate: receiptDate(normalized.period.endDate, "period.endDate")
    };
  }

  try {
    return createReceiptPayload(normalized as unknown as ReceiptPayloadInput);
  } catch (error) {
    throw new AppError({
      code: "RECEIPT_INVALID",
      message: error instanceof Error ? error.message : "Receipt payload is invalid"
    });
  }
}

function receiptDate(value: unknown, field: string): Date {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }
  if (typeof value !== "string" && typeof value !== "number") {
    throw new AppError({
      code: "RECEIPT_INVALID",
      message: `Receipt ${field} must be a valid date`,
      details: { field }
    });
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new AppError({
      code: "RECEIPT_INVALID",
      message: `Receipt ${field} must be a valid date`,
      details: { field, value }
    });
  }
  return date;
}

async function loadSession(sessionId: string): Promise<Session> {
  let raw: string;
  try {
    raw = await readFile(sessionPath(sessionId), "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new AppError({
        code: "SESSION_NOT_FOUND",
        message: `No Cheqi session found for ${sessionId}. Run cheqi session create --session ${sessionId} first.`,
        details: { sessionId },
        retryable: false
      });
    }
    throw error;
  }

  try {
    const session = JSON.parse(raw) as Session;
    if (!session.id) {
      session.id = sessionId;
    }
    return session;
  } catch (error) {
    throw new AppError({
      code: "SESSION_INVALID",
      message: `Session ${sessionId} is not valid JSON`,
      details: { sessionId, reason: error instanceof Error ? error.message : String(error) }
    });
  }
}

async function saveSession(session: Session): Promise<void> {
  await mkdir(sessionsDir, { recursive: true });
  const path = sessionPath(session.id);
  const tempPath = `${path}.${process.pid}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(session, null, 2)}\n`, "utf8");
  await rename(tempPath, path);
}

function touch(session: Session): void {
  session.updatedAt = new Date().toISOString();
}

function parseIssueDate(value: string): string {
  if (normalize(value) === "now") {
    return new Date().toISOString();
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new AppError({
      code: "INPUT_INVALID",
      message: `Invalid issue date: ${value}`,
      details: { value }
    });
  }
  return date.toISOString();
}

function recomputeTotals(receipt: Record<string, unknown>): void {
  const products = Array.isArray(receipt.products) ? receipt.products.filter(isRecord) : [];
  const subtotal = roundMoney(products.reduce((sum, product) => sum + numberValue(product.subtotal), 0));
  const taxTotal = roundMoney(products.reduce((sum, product) => {
    const taxes = Array.isArray(product.taxes) ? product.taxes.filter(isRecord) : [];
    return sum + taxes.reduce((innerSum, tax) => innerSum + numberValue(tax.amount), 0);
  }, 0));
  const total = roundMoney(products.reduce((sum, product) => sum + numberValue(product.total), 0));
  const taxMap = new Map<string, { rate: number; type: string; taxableAmount: number; amount: number; label?: string }>();

  for (const product of products) {
    const taxes = Array.isArray(product.taxes) ? product.taxes.filter(isRecord) : [];
    for (const tax of taxes) {
      const rate = numberValue(tax.rate);
      const type = typeof tax.type === "string" ? tax.type : "VAT";
      const label = typeof tax.label === "string" ? tax.label : type;
      const key = `${type}:${rate}:${label}`;
      const existing = taxMap.get(key) ?? { rate, type, label, taxableAmount: 0, amount: 0 };
      existing.taxableAmount = roundMoney(existing.taxableAmount + numberValue(tax.taxableAmount));
      existing.amount = roundMoney(existing.amount + numberValue(tax.amount));
      taxMap.set(key, existing);
    }
  }

  receipt.receiptSubtotal = subtotal;
  receipt.totalBeforeTax = subtotal;
  receipt.totalTaxAmount = taxTotal;
  receipt.totalAmount = total;
  receipt.taxesApplied = Array.from(taxMap.values()).some((tax) => tax.rate !== 0 || tax.amount !== 0);
  receipt.taxes = Array.from(taxMap.values());
}

function totals(receipt: Record<string, unknown>): Record<string, unknown> {
  return {
    receiptSubtotal: receipt.receiptSubtotal,
    totalBeforeTax: receipt.totalBeforeTax,
    totalTaxAmount: receipt.totalTaxAmount,
    totalAmount: receipt.totalAmount
  };
}

function validateReadyToFinalize(session: Session): void {
  if (!hasIdentificationDetails(session)) {
    throw new AppError({
      code: "RECEIPT_INVALID",
      message: "No match details in the session. Run cheqi session match first.",
      details: { field: "identificationDetails" }
    });
  }
  validateReceiptDraft(session.receipt);
  definitiveReceipt(session.receipt);
}

function validateReceiptDraft(receipt: Record<string, unknown>): void {
  const required = ["documentNumber", "issueDate", "currency"];
  for (const field of required) {
    if (typeof receipt[field] !== "string" || receipt[field] === "") {
      throw new AppError({
        code: "RECEIPT_INVALID",
        message: `Receipt ${field} is required. Run cheqi receipt set --session <id> --${canonicalReceiptFlag(field)} ...`,
        details: { field }
      });
    }
  }
  if (!Array.isArray(receipt.products) || receipt.products.length === 0) {
    throw new AppError({
      code: "RECEIPT_INVALID",
      message: "At least one product is required. Run cheqi receipt add-product --session <id> --name ... --price-incl ...",
      details: { field: "products" }
    });
  }
}

function canonicalReceiptFlag(field: string): string {
  const kebab = field.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
  const entry = commands.find((item) => item.command.join(" ") === "receipt set");
  return String(entry?.flags.find((flag) => flag.name === kebab)?.name ?? kebab);
}

function setIfPresent(target: Record<string, unknown>, key: string, value: string | null): void {
  if (value !== null) {
    target[key] = value;
  }
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function buildIdentificationDetails(matchBy: string, value: string): IdentificationDetails {
  const matchValue = value.trim();
  switch (normalize(matchBy)) {
    case "card_par":
      return {
        paymentType: "CARD_PAYMENT",
        ...(matchValue ? { cardDetails: { paymentAccountReference: matchValue } } : {})
      } as IdentificationDetails;
    case "pairing_code":
      return {
        paymentType: "CASH",
        ...(matchValue ? { pairingCode: matchValue } : {})
      } as IdentificationDetails;
    case "payment_account_identifier":
      return {
        paymentType: "DIRECT_DEBIT",
        ...(matchValue ? { paymentAccountDetails: {
          accountIdentifierType: "IBAN",
          identifier: matchValue
        } } : {})
      } as IdentificationDetails;
    case "email":
      return {
        paymentType: "CASH",
        ...(matchValue ? { recipientEmail: matchValue } : {})
      } as IdentificationDetails;
    case "payment_type":
      return { paymentType: parsePaymentType(matchValue) };
    default:
      throw new AppError({
        code: "FLAG_INVALID",
        message: "Unsupported --match-by. Use card_par, pairing_code, payment_account_identifier, email, or payment_type",
        details: { matchBy, supported: ["card_par", "pairing_code", "payment_account_identifier", "email", "payment_type"] }
      });
  }
}

function parsePaymentType(value: string): NonNullable<IdentificationDetails["paymentType"]> {
  const paymentType = value.trim().toUpperCase();
  if (!["CARD_PAYMENT", "CASH", "DIRECT_DEBIT"].includes(paymentType)) {
    throw new AppError({
      code: "FLAG_INVALID",
      message: "Payment type must be CARD_PAYMENT, CASH, or DIRECT_DEBIT",
      details: { flag: "payment-type", value }
    });
  }
  return paymentType as NonNullable<IdentificationDetails["paymentType"]>;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function nextStep(command: string[], requiredFlags: string[] = [], optionalFlags: string[] = [], hint?: string): NextStep {
  return { command, requiredFlags, optionalFlags, hint };
}

function statusNextStep(session: Session): NextStep | null {
  if (issueState(session) === "DIGITAL_PENDING") return nextStep(["receipt", "finalize"], ["session"]);
  if (issueState(session) === "DOWNLOAD_FALLBACK" && session.issue?.result?.retryable === true) {
    return nextStep(["receipt", "finalize"], ["session"], [], "Retry the saved prepared download upload.");
  }
  if (issueState(session) !== "DRAFT") return null;
  const productCount = Array.isArray(session.receipt.products) ? session.receipt.products.length : 0;
  if (!hasIdentificationDetails(session)) {
    return nextStep(["session", "match"], ["session"], ["card-par", "pairing-code", "payment-account-identifier", "email", "payment-type"]);
  }
  if (productCount === 0) {
    return nextStep(["receipt", "add-product"], ["session", "name"], ["price-incl", "unit-price", "vat"]);
  }
  return nextStep(["receipt", "validate"], ["session"]);
}

function requiredFlag(name: string): AppError {
  return new AppError({
    code: "FLAG_REQUIRED",
    message: `--${name} is required`,
    details: { flag: name }
  });
}

function hasIdentificationDetails(session: Session): boolean {
  return session.identificationDetails !== null;
}

function hasAnyFlag(flags: Flags, names: string[]): boolean {
  return names.some((name) => Object.prototype.hasOwnProperty.call(flags, name));
}

function isHelp(args: string[]): boolean {
  return args.includes("-h") || args.includes("--help") || (args.length === 1 && args[0] === "help");
}

function printEnvelope(ok: true, data: unknown, meta: Record<string, unknown>): void;
function printEnvelope(ok: false, data: null, meta: Record<string, unknown>, error: AppError): void;
function printEnvelope(ok: boolean, data: unknown, meta: Record<string, unknown>, error?: AppError): void {
  if (ok) {
    console.log(JSON.stringify({ ok: true, data, meta }, null, 2));
    return;
  }

  console.log(JSON.stringify({
    ok: false,
    error: {
      code: error?.code ?? "INTERNAL_ERROR",
      message: error?.message ?? "Unknown error",
      retryable: error?.retryable ?? false,
      details: error?.details ?? undefined
    },
    meta
  }, null, 2));
}

function normalizeError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }
  if (error instanceof SubmissionInProgressError) {
    return new AppError({ code: "RECEIPT_PENDING", message: "Receipt submission is still in progress", retryable: true,
      details: { retryAfterSeconds: error.retryAfterSeconds } });
  }
  if (error instanceof EncryptionError) {
    return new AppError({ code: "ENCRYPTION_FAILED", message: "Receipt encryption failed",
      details: sdkDetails(error) });
  }
  if (error instanceof CheqiSDKError) {
    const status = error.httpStatusCode;
    const code: ErrorCode = error.isNetworkError() || error.errorCode === "NETWORK_ERROR" || error.errorCode === "TIMEOUT_ERROR"
      ? "NETWORK_ERROR" : !(error instanceof CheqiApiError) ? "INTERNAL_ERROR" : status === 429 ? "RATE_LIMITED"
        : status === 401 || status === 403 ? "AUTH_INVALID"
          : status === 408 || status >= 500 ? "API_UNAVAILABLE"
            : status >= 400 && status < 500 ? "API_REJECTED" : "INTERNAL_ERROR";
    return new AppError({ code, message: safeSdkMessage(code), retryable: ["NETWORK_ERROR", "RATE_LIMITED", "API_UNAVAILABLE"].includes(code),
      details: { ...sdkDetails(error), ...(code === "RATE_LIMITED" && lastRetryAfterSeconds !== undefined ? { retryAfterSeconds: lastRetryAfterSeconds } : {}) } });
  }
  if (error instanceof Error && error.name === "FetchError") {
    return new AppError({ code: "NETWORK_ERROR", message: "Network request failed", retryable: true });
  }
  if (error instanceof Error && error.name === "ResponseError" && "response" in error) {
    const response = (error as Error & { response: Response }).response;
    const status = response.status;
    const code: ErrorCode = status === 429 ? "RATE_LIMITED" : status === 401 || status === 403 ? "AUTH_INVALID"
      : status === 408 || status >= 500 ? "API_UNAVAILABLE" : "API_REJECTED";
    return new AppError({ code, message: safeSdkMessage(code), retryable: ["RATE_LIMITED", "API_UNAVAILABLE"].includes(code),
      details: { httpStatus: status, ...(response.headers.get("x-correlation-id") ? { correlationId: response.headers.get("x-correlation-id") } : {}),
        ...(code === "RATE_LIMITED" && response.headers.get("retry-after") !== null && Number.isFinite(Number(response.headers.get("retry-after")))
          ? { retryAfterSeconds: Number(response.headers.get("retry-after")) } : {}) } });
  }
  if (error instanceof Error && error.name === "RequiredError") {
    return new AppError({ code: "INPUT_INVALID", message: "A required SDK field is missing" });
  }
  if (isNodeError(error) && ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"].includes(error.code as string)) {
    return new AppError({ code: "NETWORK_ERROR", message: "Network request failed", retryable: true });
  }
  if (error instanceof TypeError && /fetch|network/i.test(error.message)) {
    return new AppError({ code: "NETWORK_ERROR", message: "Network request failed", retryable: true });
  }
  return new AppError({
    code: "INTERNAL_ERROR",
    message: "Unexpected CLI error"
  });
}

function sdkDetails(error: CheqiSDKError): Record<string, unknown> {
  return {
    ...(error.httpStatusCode > 0 ? { httpStatus: error.httpStatusCode } : {}),
    ...(error.correlationId ? { correlationId: error.correlationId } : {}),
    ...(error.errorCode ? { sdkErrorCode: error.errorCode } : {})
  };
}

function safeSdkMessage(code: ErrorCode): string {
  switch (code) {
    case "NETWORK_ERROR": return "Network request failed";
    case "RATE_LIMITED": return "Cheqi API rate limit reached";
    case "API_UNAVAILABLE": return "Cheqi API is temporarily unavailable";
    case "API_REJECTED": return "Cheqi API rejected the request";
    case "AUTH_INVALID": return "Cheqi API rejected authentication";
    default: return "Unexpected SDK error";
  }
}

function env(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replaceAll("-", "_");
}

function parsePositiveInt(value: string | null, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

main(process.argv.slice(2));
