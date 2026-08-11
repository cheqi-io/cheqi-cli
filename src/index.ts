#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { stdin } from "node:process";
import {
  CheqiSDK,
  createReceiptPayload,
  Environment,
  NoopLogger,
  type ReceiptResult,
  type Logger,
  type IdentificationDetails,
  type ReceiptPayload,
  type ReceiptPayloadInput
} from "@cheqi/sdk";
import { parseDownloadUrl } from "@cheqi/sdk/download";

const VERSION = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
).version as string;
const SESSIONS_DIR = ".cheqi/sessions";

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
  | "SESSION_NOT_FOUND";

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
  version: 1;
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
}

async function main(args: string[]): Promise<void> {
  const startedAt = Date.now();
  try {
    const data = await route(args);
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
    process.exit(1);
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
    case "version":
      return { version: VERSION };
    case "help":
    case "-h":
    case "--help":
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
  switch (command) {
    case "create":
      if (isHelp(rest)) return commandSchema(["session", "create"]);
      return createSession(rest);
    case "match":
      if (isHelp(rest)) return commandSchema(["session", "match"]);
      return matchSession(rest);
    case "status":
      if (isHelp(rest)) return commandSchema(["session", "status"]);
      return statusSession(rest);
    case "reset":
      if (isHelp(rest)) return commandSchema(["session", "reset"]);
      return resetSession(rest);
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
  switch (command) {
    case "set":
      if (isHelp(rest)) return commandSchema(["receipt", "set"]);
      return setReceipt(rest);
    case "add-product":
      if (isHelp(rest)) return commandSchema(["receipt", "add-product"]);
      return addProduct(rest);
    case "preview":
      if (isHelp(rest)) return commandSchema(["receipt", "preview"]);
      return previewSession(rest);
    case "validate":
      if (isHelp(rest)) return commandSchema(["receipt", "validate"]);
      return validateSession(rest);
    case "finalize":
      if (isHelp(rest)) return commandSchema(["receipt", "finalize"]);
      return finalizeSession(rest);
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
  switch (command) {
    case "submit":
      if (isHelp(rest)) return commandSchema(["receipts", "submit"]);
      return submitReceipt(rest);
    case "submit-download":
      if (isHelp(rest)) return commandSchema(["receipts", "submit-download"]);
      return submitDownloadReceipt(rest);
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
  return commandSchema(args);
}

async function createSession(args: string[]): Promise<unknown> {
  const flags = parseFlags(args);
  const now = new Date().toISOString();
  const sessionId = requireSessionId(flags);
  const session: Session = {
    version: 1,
    id: sessionId,
    createdAt: now,
    updatedAt: now,
    auth: {
      env: stringFlag(flags, "env") ?? env("CHEQI_ENV") ?? "sandbox",
      endpoint: stringFlag(flags, "endpoint") ?? env("CHEQI_API_ENDPOINT")
    },
    identificationDetails: null,
    matchResponse: null,
    receipt: {
      documentNumber: stringFlag(flags, "document-number") ?? stringFlag(flags, "documentNumber") ?? `RECEIPT-${Date.now()}`,
      issueDate: parseIssueDate(stringFlag(flags, "issue-date") ?? stringFlag(flags, "issueDate") ?? "now"),
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
  const flags = parseFlags(args);
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
  const flags = parseFlags(args);
  const session = await loadSession(requireSessionId(flags));
  const receipt = session.receipt;

  setIfPresent(receipt, "documentNumber", stringFlag(flags, "document-number") ?? stringFlag(flags, "documentNumber"));
  setIfPresent(receipt, "currency", stringFlag(flags, "currency"));
  const issueDate = stringFlag(flags, "issue-date") ?? stringFlag(flags, "issueDate");
  if (issueDate) {
    receipt.issueDate = parseIssueDate(issueDate);
  }
  setIfPresent(receipt, "note", stringFlag(flags, "note"));

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
  const flags = parseFlags(args);
  const positionalName = flags._[0];
  const name = stringFlag(flags, "name") ?? positionalName;
  if (!name) {
    throw new AppError({
      code: "FLAG_REQUIRED",
      message: "Product name is required. Use --name \"Nike Shoes\" or pass the name as the first argument.",
      details: { flag: "name" }
    });
  }

  const quantity = numberFlag(flags, "quantity") ?? numberFlag(flags, "qty") ?? 1;
  const vatRate = numberFlag(flags, "vat") ?? numberFlag(flags, "tax-rate") ?? numberFlag(flags, "taxRate") ?? 0;
  const taxType = stringFlag(flags, "tax-type") ?? stringFlag(flags, "taxType") ?? "VAT";
  const unitCode = stringFlag(flags, "unit-code") ?? stringFlag(flags, "unitCode") ?? "C62";
  const brandName = stringFlag(flags, "brand") ?? stringFlag(flags, "brand-name") ?? "";
  const identifier = stringFlag(flags, "identifier") ?? stringFlag(flags, "sku");

  const priceIncl = numberFlag(flags, "price-incl") ?? numberFlag(flags, "priceIncl") ?? numberFlag(flags, "gross");
  const unitPrice = numberFlag(flags, "unit-price") ?? numberFlag(flags, "unitPrice") ?? numberFlag(flags, "price-excl") ?? numberFlag(flags, "priceExcl");

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
    label: stringFlag(flags, "tax-label") ?? stringFlag(flags, "taxLabel") ?? taxType
  };

  const session = await loadSession(requireSessionId(flags));
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

async function previewSession(args: string[]): Promise<unknown> {
  const session = await loadSession(requireSessionId(parseFlags(args)));
  recomputeTotals(session.receipt);
  return {
    session,
    nextStep: nextStep(["receipt", "validate"], ["session"], [], "Validate locally before finalizing.")
  };
}

async function statusSession(args: string[]): Promise<unknown> {
  const session = await loadSession(requireSessionId(parseFlags(args)));
  return {
    sessionId: session.id,
    session: sessionPath(session.id),
    hasMatch: hasIdentificationDetails(session),
    hasMatchResponse: Boolean(session.matchResponse),
    productCount: Array.isArray(session.receipt.products) ? session.receipt.products.length : 0,
    totals: totals(session.receipt),
    updatedAt: session.updatedAt,
    nextStep: statusNextStep(session)
  };
}

async function validateSession(args: string[]): Promise<unknown> {
  const session = await loadSession(requireSessionId(parseFlags(args)));
  recomputeTotals(session.receipt);
  validateReadyToFinalize(session);
  return {
    valid: true,
    sessionId: session.id,
    totals: totals(session.receipt),
    nextStep: nextStep(["receipt", "finalize"], ["session"], ["api-key", "access-token", "env", "endpoint", "timeout"], "Finalize only after local validation succeeds.")
  };
}

async function finalizeSession(args: string[]): Promise<unknown> {
  const auth = parseAuthOptions(args);
  validateAuth(auth);
  const flags = parseFlags(args);
  const session = await loadSession(requireSessionId(flags));
  recomputeTotals(session.receipt);
  validateReadyToFinalize(session);

  const sdk = buildSDK({
    ...auth,
    env: stringFlag(flags, "env") ?? session.auth.env ?? auth.env,
    endpoint: stringFlag(flags, "endpoint") ?? session.auth.endpoint ?? auth.endpoint
  });

  const result = await sdk.receiptService.issueReceipt(
    session.identificationDetails as unknown as IdentificationDetails,
    definitiveReceipt(session.receipt),
    auth.accessToken
  );

  return {
    ...receiptResultData(result),
    sessionId: session.id,
    session: sessionPath(session.id)
  };
}

async function resetSession(args: string[]): Promise<unknown> {
  const sessionId = requireSessionId(parseFlags(args));
  await rm(sessionPath(sessionId), { force: true });
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
    options.accessToken
  );

  return receiptResultData(result);
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
  return receiptResultData(result);
}

function parseSubmitDownloadOptions(args: string[]): SubmitDownloadOptions {
  const options: SubmitDownloadOptions = {
    apiKey: env("CHEQI_API_KEY"),
    accessToken: env("CHEQI_ACCESS_TOKEN"),
    env: env("CHEQI_ENV") ?? "sandbox",
    endpoint: env("CHEQI_API_ENDPOINT"),
    receiptPath: null,
    downloadBaseUrl: env("CHEQI_DOWNLOAD_BASE_URL"),
    paymentType: "CASH",
    timeoutSeconds: parsePositiveInt(env("CHEQI_TIMEOUT_SECONDS"), 30),
    verbose: false
  };

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    switch (arg) {
      case "--api-key":
        options.apiKey = readFlagValue(args, ++index, arg);
        break;
      case "--access-token":
        options.accessToken = readFlagValue(args, ++index, arg);
        break;
      case "--env":
        options.env = readFlagValue(args, ++index, arg);
        break;
      case "--endpoint":
        options.endpoint = readFlagValue(args, ++index, arg);
        break;
      case "--receipt":
        options.receiptPath = readFlagValue(args, ++index, arg);
        break;
      case "--download-base-url":
        options.downloadBaseUrl = readFlagValue(args, ++index, arg);
        break;
      case "--payment-type": {
        options.paymentType = parsePaymentType(readFlagValue(args, ++index, arg));
        break;
      }
      case "--timeout":
        options.timeoutSeconds = parsePositiveInt(readFlagValue(args, ++index, arg), 30);
        break;
      case "--verbose":
        options.verbose = true;
        break;
      default:
        throw new AppError({
          code: "FLAG_INVALID",
          message: `Unknown option: ${arg}`,
          details: { flag: arg }
        });
    }
  }

  return options;
}

function commandSchema(path: string[] = []): unknown {
  const commands = [
    {
      command: ["session", "create"],
      summary: "Create a local receipt session.",
      positional: [],
      flags: [
        flag("session", "string", true),
        flag("currency", "string", false, "EUR"),
        flag("document-number", "string", false),
        flag("issue-date", "string", false, "now"),
        flag("env", "enum", false, "sandbox", ["sandbox", "test", "production"]),
        flag("endpoint", "string", false),
        flag("card-par", "string", false),
        flag("pairing-code", "string", false),
        flag("payment-account-identifier", "string", false),
        flag("email", "string", false),
        flag("payment-type", "enum", false, undefined, ["CARD_PAYMENT", "CASH", "DIRECT_DEBIT"])
      ],
      response: "SessionCreateResponse",
      responseSchema: responseSchema("SessionCreateResponse")
    },
    {
      command: ["session", "match"],
      summary: "Match a customer for an existing session.",
      positional: [],
      flags: authFlags([
        flag("session", "string", true),
        flag("card-par", "string", false),
        flag("pairing-code", "string", false),
        flag("payment-account-identifier", "string", false),
        flag("email", "string", false),
        flag("payment-type", "enum", false, undefined, ["CARD_PAYMENT", "CASH", "DIRECT_DEBIT"])
      ]),
      response: "SessionMatchResponse",
      responseSchema: responseSchema("SessionMatchResponse")
    },
    {
      command: ["session", "status"],
      summary: "Inspect local session state.",
      positional: [],
      flags: [flag("session", "string", true)],
      response: "SessionStatusResponse",
      responseSchema: responseSchema("SessionStatusResponse")
    },
    {
      command: ["session", "reset"],
      summary: "Delete a local session.",
      positional: [],
      flags: [flag("session", "string", true)],
      response: "SessionResetResponse",
      responseSchema: responseSchema("SessionResetResponse")
    },
    {
      command: ["receipt", "set"],
      summary: "Update receipt-level fields.",
      positional: [],
      flags: [
        flag("session", "string", true),
        flag("document-number", "string", false),
        flag("currency", "string", false),
        flag("issue-date", "string", false),
        flag("note", "string", false)
      ],
      response: "ReceiptSetResponse",
      responseSchema: responseSchema("ReceiptSetResponse")
    },
    {
      command: ["receipt", "add-product"],
      summary: "Append a product line to a local receipt draft.",
      positional: [
        {
          name: "name",
          type: "string",
          required: false,
          description: "Product name. Equivalent to --name when present."
        }
      ],
      flags: [
        flag("session", "string", true),
        flag("name", "string", false),
        flag("price-incl", "number", false),
        flag("unit-price", "number", false),
        flag("quantity", "number", false, 1),
        flag("vat", "number", false, 0),
        flag("tax-type", "string", false, "VAT"),
        flag("unit-code", "string", false, "C62"),
        flag("brand", "string", false),
        flag("sku", "string", false)
      ],
      response: "ReceiptAddProductResponse",
      responseSchema: responseSchema("ReceiptAddProductResponse")
    },
    {
      command: ["receipt", "preview"],
      summary: "Return the full local session draft.",
      positional: [],
      flags: [flag("session", "string", true)],
      response: "ReceiptPreviewResponse",
      responseSchema: responseSchema("ReceiptPreviewResponse")
    },
    {
      command: ["receipt", "validate"],
      summary: "Validate local receipt state without network side effects.",
      positional: [],
      flags: [flag("session", "string", true)],
      response: "ReceiptValidateResponse",
      responseSchema: responseSchema("ReceiptValidateResponse")
    },
    {
      command: ["receipt", "finalize"],
      summary: "Submit an existing local session receipt.",
      positional: [],
      flags: authFlags([flag("session", "string", true)]),
      response: "ReceiptFinalizeResponse",
      responseSchema: responseSchema("ReceiptFinalizeResponse")
    },
    {
      command: ["receipts", "submit"],
      summary: "Submit a receipt JSON file or stdin without creating a local session.",
      positional: [],
      flags: authFlags([
        flag("receipt", "string", true),
        flag("match-by", "enum", true, undefined, ["card_par", "pairing_code", "payment_account_identifier", "email", "payment_type"]),
        flag("match-value", "string", true)
      ]),
      response: "ReceiptSubmitResponse",
      responseSchema: responseSchema("ReceiptSubmitResponse")
    },
    {
      command: ["receipts", "submit-download"],
      summary: "Issue a receipt via a client-generated, E2E-encrypted download link (no customer matching). The QR-ready URL carries the decryption key in its #fragment.",
      positional: [],
      flags: authFlags([
        flag("receipt", "string", true),
        flag("payment-type", "enum", false, "CASH", ["CARD_PAYMENT", "CASH", "DIRECT_DEBIT"])
      ]),
      response: "ReceiptSubmitDownloadResponse",
      responseSchema: responseSchema("ReceiptSubmitDownloadResponse")
    }
  ];

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
    commands: selected
  };
}

function flag(name: string, type: string, required: boolean, defaultValue?: unknown, values?: string[]): Record<string, unknown> {
  return { name, type, required, default: defaultValue, values };
}

function responseSchema(name: string): Record<string, unknown> {
  const baseProperties = {
    sessionId: { type: "string" },
    session: { type: "string" },
    nextStep: nextStepSchema()
  };

  switch (name) {
    case "SessionCreateResponse":
      return objectSchema({
        ...baseProperties,
        receipt: { type: "object", additionalProperties: true },
        hasMatch: { type: "boolean" }
      }, ["sessionId", "session", "receipt", "hasMatch", "nextStep"]);
    case "SessionMatchResponse":
      return objectSchema({
        ...baseProperties,
        routeFound: { type: "boolean" },
        deliveryRouteType: { type: "string", enum: ["DIGITAL", "EMAIL_FALLBACK", "DOWNLOAD_FALLBACK"] },
        matchId: { type: "string" },
        expiresAt: { type: "string", format: "date-time" },
        recipientCount: { type: "number" }
      }, ["sessionId", "session", "routeFound", "recipientCount", "nextStep"]);
    case "SessionStatusResponse":
      return objectSchema({
        ...baseProperties,
        hasMatch: { type: "boolean" },
        hasMatchResponse: { type: "boolean" },
        productCount: { type: "number" },
        totals: totalsSchema(),
        updatedAt: { type: "string", format: "date-time" }
      }, ["sessionId", "session", "hasMatch", "hasMatchResponse", "productCount", "totals", "updatedAt", "nextStep"]);
    case "SessionResetResponse":
      return objectSchema({
        sessionId: { type: "string" },
        session: { type: "string" },
        reset: { type: "boolean", const: true }
      }, ["sessionId", "session", "reset"]);
    case "ReceiptSetResponse":
      return objectSchema({
        ...baseProperties,
        receipt: { type: "object", additionalProperties: true }
      }, ["sessionId", "session", "receipt", "nextStep"]);
    case "ReceiptAddProductResponse":
      return objectSchema({
        ...baseProperties,
        added: { type: "object", additionalProperties: true },
        totals: totalsSchema()
      }, ["sessionId", "session", "added", "totals", "nextStep"]);
    case "ReceiptPreviewResponse":
      return objectSchema({
        session: { type: "object", additionalProperties: true },
        nextStep: nextStepSchema()
      }, ["session", "nextStep"]);
    case "ReceiptValidateResponse":
      return objectSchema({
        valid: { type: "boolean", const: true },
        sessionId: { type: "string" },
        totals: totalsSchema(),
        nextStep: nextStepSchema()
      }, ["valid", "sessionId", "totals", "nextStep"]);
    case "ReceiptFinalizeResponse":
    case "ReceiptSubmitResponse":
    case "ReceiptSubmitDownloadResponse":
      return objectSchema({
        success: { type: "boolean" },
        accepted: { type: "boolean" },
        deliveryRouteType: { type: "string", enum: ["DIGITAL", "EMAIL_FALLBACK", "DOWNLOAD_FALLBACK"] },
        status: { type: "string" },
        matchId: { type: "string" },
        cheqiReceiptId: { type: "string" },
        createdAt: { type: "string", format: "date-time" },
        expiresAt: { type: "string", format: "date-time" },
        downloadUrl: { type: "string", description: "Customer-facing URL with the AES key in the #fragment; render as QR, never log server-side." },
        downloadId: { type: "string" },
        downloadEnvelopeRequired: { type: "boolean" },
        emailReceiptRequired: { type: "boolean" },
        sessionId: { type: "string" },
        session: { type: "string" }
      }, ["success", "accepted", "deliveryRouteType", "downloadEnvelopeRequired", "emailReceiptRequired"]);
    default:
      return objectSchema({}, []);
  }
}

function objectSchema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required,
    properties
  };
}

function nextStepSchema(): Record<string, unknown> {
  return objectSchema({
    command: { type: "array", items: { type: "string" } },
    requiredFlags: { type: "array", items: { type: "string" } },
    optionalFlags: { type: "array", items: { type: "string" } },
    hint: { type: "string" }
  }, ["command"]);
}

function totalsSchema(): Record<string, unknown> {
  return objectSchema({
    receiptSubtotal: { type: "number" },
    totalBeforeTax: { type: "number" },
    totalTaxAmount: { type: "number" },
    totalAmount: { type: "number" }
  }, ["receiptSubtotal", "totalBeforeTax", "totalTaxAmount", "totalAmount"]);
}

function authFlags(flags: Record<string, unknown>[]): Record<string, unknown>[] {
  return [
    ...flags,
    flag("api-key", "string", false),
    flag("access-token", "string", false),
    flag("env", "enum", false, "sandbox", ["sandbox", "test", "production"]),
    flag("endpoint", "string", false),
    flag("download-base-url", "string", false),
    flag("timeout", "number", false, 30),
    flag("verbose", "boolean", false, false)
  ];
}

function parseSubmitOptions(args: string[]): SubmitOptions {
  const options: SubmitOptions = {
    apiKey: env("CHEQI_API_KEY"),
    accessToken: env("CHEQI_ACCESS_TOKEN"),
    env: env("CHEQI_ENV") ?? "sandbox",
    endpoint: env("CHEQI_API_ENDPOINT"),
    downloadBaseUrl: env("CHEQI_DOWNLOAD_BASE_URL"),
    receiptPath: null,
    matchBy: null,
    matchValue: null,
    timeoutSeconds: parsePositiveInt(env("CHEQI_TIMEOUT_SECONDS"), 30),
    verbose: false
  };

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    switch (arg) {
      case "--api-key":
        options.apiKey = readFlagValue(args, ++index, arg);
        break;
      case "--access-token":
        options.accessToken = readFlagValue(args, ++index, arg);
        break;
      case "--env":
        options.env = readFlagValue(args, ++index, arg);
        break;
      case "--endpoint":
        options.endpoint = readFlagValue(args, ++index, arg);
        break;
      case "--download-base-url":
        options.downloadBaseUrl = readFlagValue(args, ++index, arg);
        break;
      case "--receipt":
        options.receiptPath = readFlagValue(args, ++index, arg);
        break;
      case "--match-by":
        options.matchBy = readFlagValue(args, ++index, arg);
        break;
      case "--match-value":
        options.matchValue = readPossiblyEmptyFlagValue(args, ++index, arg);
        break;
      case "--timeout":
        options.timeoutSeconds = parsePositiveInt(readFlagValue(args, ++index, arg), 30);
        break;
      case "--verbose":
        options.verbose = true;
        break;
      default:
        throw new AppError({
          code: "FLAG_INVALID",
          message: `Unknown option: ${arg}`,
          details: { flag: arg }
        });
    }
  }

  return options;
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
  const flags = parseFlags(args);
  return {
    apiKey: stringFlag(flags, "api-key") ?? stringFlag(flags, "apiKey") ?? env("CHEQI_API_KEY"),
    accessToken: stringFlag(flags, "access-token") ?? stringFlag(flags, "accessToken") ?? env("CHEQI_ACCESS_TOKEN"),
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
  return new CheqiSDK({
    apiEndpoint: resolveEndpoint(options),
    apiKey: options.apiKey,
    receiptDownloadBaseUrl: options.downloadBaseUrl ?? resolveDownloadBaseUrl(options),
    timeoutSeconds: options.timeoutSeconds,
    logger: options.verbose ? new StderrLogger() : new NoopLogger()
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

function parseFlags(args: string[]): Flags {
  const flags: Flags = { _: [] };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg.startsWith("--")) {
      const withoutPrefix = arg.slice(2);
      const equalsIndex = withoutPrefix.indexOf("=");
      if (equalsIndex >= 0) {
        flags[withoutPrefix.slice(0, equalsIndex)] = withoutPrefix.slice(equalsIndex + 1);
        continue;
      }
      const next = args[index + 1];
      if (next && !next.startsWith("--")) {
        flags[withoutPrefix] = next;
        index++;
      } else {
        flags[withoutPrefix] = true;
      }
      continue;
    }

    const colonIndex = arg.indexOf(":");
    if (colonIndex > 0) {
      flags[arg.slice(0, colonIndex)] = arg.slice(colonIndex + 1);
      continue;
    }

    flags._.push(arg);
  }
  return flags;
}

function requireSessionId(flags: Flags): string {
  const sessionId = sessionIdFromFlags(flags);
  if (!sessionId) {
    throw requiredFlag("session");
  }
  return sessionId;
}

function sessionIdFromFlags(flags: Flags): string | null {
  return sanitizeSessionId(stringFlag(flags, "session") ?? stringFlag(flags, "session-id") ?? stringFlag(flags, "sessionId"));
}

function sanitizeSessionId(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const sanitized = value.trim().replace(/[^A-Za-z0-9._-]/g, "-");
  if (!sanitized || sanitized === "." || sanitized === "..") {
    throw new AppError({
      code: "SESSION_INVALID",
      message: "Invalid session id",
      details: { value }
    });
  }
  return sanitized;
}

function sessionPath(sessionId: string): string {
  return `${SESSIONS_DIR}/${sessionId}.json`;
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
  const cardPar = stringFlag(flags, "card-par") ?? stringFlag(flags, "cardPar");
  if (cardPar !== null) {
    return buildIdentificationDetails("card_par", cardPar);
  }

  const pairingCode = stringFlag(flags, "pairing-code") ?? stringFlag(flags, "pairingCode");
  if (pairingCode !== null) {
    return buildIdentificationDetails("pairing_code", pairingCode);
  }

  const paymentAccountIdentifier = stringFlag(flags, "payment-account-identifier")
    ?? stringFlag(flags, "paymentAccountIdentifier")
    ?? stringFlag(flags, "iban");
  if (paymentAccountIdentifier !== null) {
    return buildIdentificationDetails("payment_account_identifier", paymentAccountIdentifier);
  }

  const email = stringFlag(flags, "email");
  if (email !== null) {
    return buildIdentificationDetails("email", email);
  }

  const paymentType = stringFlag(flags, "payment-type") ?? stringFlag(flags, "paymentType");
  if (paymentType !== null) {
    return buildIdentificationDetails("payment_type", paymentType);
  }

  if (hasAnyFlag(flags, ["card-par", "cardPar"])) return buildIdentificationDetails("card_par", "");
  if (hasAnyFlag(flags, ["pairing-code", "pairingCode"])) return buildIdentificationDetails("pairing_code", "");
  if (hasAnyFlag(flags, ["payment-account-identifier", "paymentAccountIdentifier", "iban"])) {
    return buildIdentificationDetails("payment_account_identifier", "");
  }
  if (hasAnyFlag(flags, ["email"])) return buildIdentificationDetails("email", "");
  if (hasAnyFlag(flags, ["payment-type", "paymentType"])) {
    throw new AppError({
      code: "FLAG_REQUIRED",
      message: "--payment-type requires a value",
      details: { flag: "payment-type" }
    });
  }

  return null;
}

async function readReceipt(path: string): Promise<Record<string, unknown>> {
  const raw = path === "-" ? await readStdin() : await readFile(path, "utf8");
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
  await mkdir(SESSIONS_DIR, { recursive: true });
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
        message: `Receipt ${field} is required. Run cheqi receipt set --session <id> --${field} ...`,
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

function readFlagValue(args: string[], index: number, flagName: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new AppError({
      code: "FLAG_REQUIRED",
      message: `${flagName} requires a value`,
      details: { flag: flagName.replace(/^--/, "") }
    });
  }
  return value;
}

function readPossiblyEmptyFlagValue(args: string[], index: number, flagName: string): string {
  const value = args[index];
  if (value === undefined || value.startsWith("--")) {
    throw new AppError({
      code: "FLAG_REQUIRED",
      message: `${flagName} requires a value`,
      details: { flag: flagName.replace(/^--/, "") }
    });
  }
  return value;
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

function statusNextStep(session: Session): NextStep {
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
  return args.length === 1 && (args[0] === "help" || args[0] === "-h" || args[0] === "--help");
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
      code: error?.code ?? "INPUT_INVALID",
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
  return new AppError({
    code: "INPUT_INVALID",
    message: error instanceof Error ? error.message : String(error)
  });
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
