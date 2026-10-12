/** Command and error contract shared by the CLI and generated agent skill. */
export const ERROR_DEFINITIONS = [
  { code: "AUTH_REQUIRED", retryable: false, exitCode: 3, meaning: "Authentication is required." },
  { code: "AUTH_CONFLICT", retryable: false, exitCode: 3, meaning: "Choose one authentication method." },
  { code: "COMMAND_NOT_FOUND", retryable: false, exitCode: 2, meaning: "The command does not exist." },
  { code: "ENV_UNSUPPORTED", retryable: false, exitCode: 2, meaning: "The environment is unsupported." },
  { code: "FLAG_INVALID", retryable: false, exitCode: 2, meaning: "A flag or value is invalid." },
  { code: "FLAG_REQUIRED", retryable: false, exitCode: 2, meaning: "A required flag is missing." },
  { code: "INPUT_INVALID", retryable: false, exitCode: 2, meaning: "Input cannot be parsed." },
  { code: "RECEIPT_INVALID", retryable: false, exitCode: 1, meaning: "Receipt content is invalid." },
  { code: "SESSION_INVALID", retryable: false, exitCode: 2, meaning: "The session ID or file is invalid." },
  { code: "SESSION_NOT_FOUND", retryable: false, exitCode: 1, meaning: "The session does not exist." },
  { code: "NETWORK_ERROR", retryable: true, exitCode: 4, meaning: "The network request failed or timed out." },
  { code: "RATE_LIMITED", retryable: true, exitCode: 4, meaning: "The API rate limit was reached." },
  { code: "API_UNAVAILABLE", retryable: true, exitCode: 4, meaning: "The API timed out or is unavailable." },
  { code: "API_REJECTED", retryable: false, exitCode: 1, meaning: "The API rejected the request." },
  { code: "AUTH_INVALID", retryable: false, exitCode: 3, meaning: "The API rejected authentication." },
  { code: "ENCRYPTION_FAILED", retryable: false, exitCode: 1, meaning: "Local receipt encryption failed." },
  { code: "INTERNAL_ERROR", retryable: false, exitCode: 1, meaning: "An unexpected CLI error occurred." },
  { code: "RECEIPT_PENDING", retryable: true, exitCode: 4, meaning: "Submission is uncertain; resume the original match." },
  { code: "RECEIPT_EXPIRED", retryable: false, exitCode: 1, meaning: "The original digital match expired." },
  { code: "SESSION_FINALIZED", retryable: false, exitCode: 2, meaning: "The receipt payload is frozen." },
  { code: "SESSION_LOCKED", retryable: true, exitCode: 4, meaning: "The session is busy; retry shortly." }
] as const;

export const commands = [
    {
      command: ["schema"],
      summary: "Inspect the machine-readable command and error contract.",
      positional: [{ name: "command", type: "string", required: false, description: "Optional command path to filter schema entries." }],
      flags: [],
      response: "SchemaResponse",
      responseSchema: responseSchema("SchemaResponse")
    },
    {
      command: ["version"],
      summary: "Return the CLI version.",
      positional: [], flags: [], response: "VersionResponse", responseSchema: responseSchema("VersionResponse")
    },
    {
      command: ["help"],
      summary: "Return the machine-readable command schema.",
      positional: [], flags: [], response: "SchemaResponse", responseSchema: responseSchema("SchemaResponse")
    },
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
        flag("quantity", "number", false, 1, undefined, ["qty"]),
        flag("vat", "number", false, 0),
        flag("tax-type", "string", false, "VAT"),
        flag("unit-code", "string", false, "C62"),
        flag("brand", "string", false),
        flag("identifier", "string", false, undefined, undefined, ["sku"]),
        flag("tax-label", "string", false)
      ],
      response: "ReceiptAddProductResponse",
      responseSchema: responseSchema("ReceiptAddProductResponse")
    },
    {
      command: ["receipt", "remove-product"],
      summary: "Remove a product line by identifier or one-based index.",
      positional: [],
      flags: [flag("session", "string", true), flag("line", "string", true)],
      response: "ReceiptRemoveProductResponse",
      responseSchema: responseSchema("ReceiptRemoveProductResponse")
    },
    {
      command: ["receipt", "list-products"],
      summary: "List the current product lines.",
      positional: [],
      flags: [flag("session", "string", true)],
      response: "ReceiptListProductsResponse",
      responseSchema: responseSchema("ReceiptListProductsResponse")
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
      flags: authFlags([flag("session", "string", true), flag("fallback", "enum", false, undefined, ["download"])]),
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
      command: ["receipts", "validate"],
      summary: "Validate a definitive receipt JSON payload without authentication or network access.",
      positional: [],
      flags: [flag("receipt", "string", true)],
      response: "ReceiptDirectValidateResponse",
      responseSchema: responseSchema("ReceiptDirectValidateResponse")
    },
    {
      command: ["receipts", "resume"],
      summary: "Resume a pending direct digital submission using its original match ID and payload.",
      positional: [],
      flags: authFlags([flag("match-id", "string", true), flag("receipt", "string", true)]),
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
    },
    {
      command: ["skill"],
      summary: "Return the bundled agent skill as JSON or raw Markdown.",
      positional: [],
      flags: [flag("raw", "boolean", false)],
      response: "SkillResponse",
      responseSchema: responseSchema("SkillResponse")
    },
    {
      command: ["skill", "install"],
      summary: "Install the bundled agent skill into a local skills directory.",
      positional: [],
      flags: [flag("dir", "string", false), flag("force", "boolean", false)],
      response: "SkillInstallResponse",
      responseSchema: responseSchema("SkillInstallResponse")
    }
  ];

  for (const entry of commands) {
    if (entry.command[0] === "session" || entry.command[0] === "receipt") {
      entry.flags.push(flag("sessions-dir", "string", false));
    }
    entry.flags.push(flag("help", "boolean", false, undefined, undefined, ["-h"]));
  }


function flag(name: string, type: string, required: boolean, defaultValue?: unknown, values?: string[], aliases?: string[]): Record<string, unknown> {
  const descriptions: Record<string, string> = {
    session: "Explicit local session ID.", currency: "Receipt currency code.", "document-number": "Merchant document number.",
    "issue-date": "Receipt issue date or now.", env: "Cheqi environment.", endpoint: "Cheqi API endpoint override.",
    "card-par": "Card payment account reference.", "pairing-code": "Customer pairing code.",
    "payment-account-identifier": "Payment account identifier.", email: "Customer email address.",
    "payment-type": "Payment type for anonymous matching.", "api-key": "Cheqi API key; prefer CHEQI_API_KEY.",
    "access-token": "Cheqi access token; prefer CHEQI_ACCESS_TOKEN.", "download-base-url": "Receipt download page base URL.",
    timeout: "Request timeout in seconds.", verbose: "Write SDK diagnostics to stderr.", note: "Receipt note.",
    name: "Product name.", "price-incl": "Gross price per unit including VAT.", "unit-price": "Net price per unit excluding VAT.",
    quantity: "Number of units.", vat: "VAT rate as a percentage.", "tax-type": "Tax type label.",
    "unit-code": "Unit of measure code.", brand: "Product brand.", identifier: "Product line identifier or SKU.",
    "tax-label": "Display label for the tax.", receipt: "Receipt JSON path or - for stdin.",
    "match-by": "Customer identifier type.", "match-value": "Customer identifier value.", "match-id": "Original match ID for recovery.",
    fallback: "Use the persisted download fallback.", "sessions-dir": "Absolute or relative directory for local sessions.",
    line: "Product identifier or one-based line index.", raw: "Print plain Markdown instead of a JSON envelope.",
    dir: "Target skills directory.", force: "Replace an installed newer skill.",
    help: "Return this command's schema before validation."
  };
  return { name, type, required, default: defaultValue, values, aliases, description: descriptions[name] ?? `Value for ${name}.` };
}

function responseSchema(name: string): Record<string, unknown> {
  const baseProperties = {
    sessionId: { type: "string" },
    session: { type: "string" },
    nextStep: nextStepSchema()
  };

  switch (name) {
    case "SchemaResponse":
      return objectSchema({ version: { type: "string" }, envelope: { type: "object", additionalProperties: true },
        commands: { type: "array", items: { type: "object", additionalProperties: true } },
        errors: { type: "array", items: { type: "object", additionalProperties: true } } },
        ["version", "envelope", "commands", "errors"]);
    case "VersionResponse":
      return objectSchema({ version: { type: "string" } }, ["version"]);
    case "SkillResponse":
      return objectSchema({ content: { type: "string" }, version: { type: "string" } }, ["content", "version"]);
    case "SkillInstallResponse":
      return objectSchema({ path: { type: "string" }, version: { type: "string" } }, ["path", "version"]);
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
        nextStep: { anyOf: [nextStepSchema(), { type: "null" }] },
        hasMatch: { type: "boolean" },
        hasMatchResponse: { type: "boolean" },
        productCount: { type: "number" },
        issueState: { type: "string", enum: ["DRAFT", "DIGITAL_SUBMITTED", "DIGITAL_PENDING", "DIGITAL_EXPIRED", "DOWNLOAD_FALLBACK", "EMAIL_FALLBACK"] },
        totals: totalsSchema(),
        updatedAt: { type: "string", format: "date-time" }
      }, ["sessionId", "session", "hasMatch", "hasMatchResponse", "productCount", "issueState", "totals", "updatedAt", "nextStep"]);
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
    case "ReceiptRemoveProductResponse":
      return objectSchema({ ...baseProperties, removed: { type: "object", additionalProperties: true }, totals: totalsSchema() },
        ["sessionId", "session", "removed", "totals", "nextStep"]);
    case "ReceiptListProductsResponse":
      return objectSchema({ ...baseProperties, nextStep: { anyOf: [nextStepSchema(), { type: "null" }] },
        products: { type: "array", items: { type: "object", additionalProperties: true } },
        totals: totalsSchema() }, ["sessionId", "session", "products", "totals", "nextStep"]);
    case "ReceiptDirectValidateResponse":
      return objectSchema({ valid: { type: "boolean", const: true }, totals: totalsSchema() }, ["valid", "totals"]);
    case "ReceiptPreviewResponse":
      return objectSchema({
        session: { type: "string" },
        draft: { type: "object", additionalProperties: true },
        nextStep: nextStepSchema()
      }, ["session", "draft", "nextStep"]);
    case "ReceiptValidateResponse":
      return objectSchema({
        valid: { type: "boolean", const: true },
        sessionId: { type: "string" },
        session: { type: "string" },
        totals: totalsSchema(),
        nextStep: nextStepSchema()
      }, ["valid", "sessionId", "session", "totals", "nextStep"]);
    case "ReceiptFinalizeResponse":
    case "ReceiptSubmitResponse":
    case "ReceiptSubmitDownloadResponse":
      return objectSchema({
        success: { type: "boolean" },
        accepted: { type: "boolean" },
        state: { type: "string", enum: ["DIGITAL_SUBMITTED", "DIGITAL_PENDING", "DIGITAL_EXPIRED", "DOWNLOAD_FALLBACK", "EMAIL_FALLBACK"] },
        retryable: { type: "boolean" },
        retryAfterSeconds: { type: "number" },
        alreadyFinalized: { type: "boolean" },
        preparedDownload: objectSchema({
          downloadUrl: { type: "string" },
          uploadRequest: objectSchema({
            downloadId: { type: "string" },
            ciphertext: { type: "string" },
            templateHash: { type: "string" }
          }, ["downloadId", "ciphertext", "templateHash"])
        }, ["downloadUrl", "uploadRequest"]),
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
      }, ["success", "accepted", "state", "retryable", "deliveryRouteType", "downloadEnvelopeRequired", "emailReceiptRequired"]);
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

