# Cheqi CLI

Agent-friendly CLI wrapper around `@cheqi/sdk`.

The CLI uses the SDK 2.5.0 definitive receipt flow: it resolves a delivery route from the supplied identification details, encrypts the exact merchant-supplied receipt payload for that route, and issues it without a server-side receipt-template step.

Every command returns a JSON envelope on stdout:

```json
{
  "ok": true,
  "data": {},
  "meta": {
    "durationMs": 12,
    "version": "0.4.0"
  }
}
```

Failures use the same shape and include stable error codes:

```json
{
  "ok": false,
  "error": {
    "code": "SESSION_NOT_FOUND",
    "message": "No Cheqi session found for agent-a. Run cheqi session create --session agent-a first.",
    "retryable": false,
    "details": {
      "sessionId": "agent-a"
    }
  },
  "meta": {
    "durationMs": 4,
    "version": "0.4.0"
  }
}
```

## Incremental Session Workflow

```bash
cheqi session create \
  --session agent-a \
  --currency EUR \
  --document-number INV-001 \
  --card-par YOUR_CARD_PAR

cheqi receipt add-product \
  --session agent-a \
  --name "Nike Shoes" \
  --price-incl 200 \
  --vat 21

cheqi receipt validate --session agent-a
cheqi receipt preview --session agent-a
CHEQI_API_KEY=sk_... cheqi receipt finalize --session agent-a
```

Drafts are stored locally in `.cheqi/sessions/<session-id>.json`. Set `CHEQI_SESSIONS_DIR` or pass `--sessions-dir` to place them elsewhere. Session responses return the absolute file path. Sessions are always explicit; pass `--session` on every command so concurrent agents do not share implicit state. Session IDs must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`.

`session status` reports `issueState`: `DRAFT`, `DIGITAL_PENDING`, `DIGITAL_SUBMITTED`, `DIGITAL_EXPIRED`, `DOWNLOAD_FALLBACK`, or `EMAIL_FALLBACK`. Finalization freezes the definitive payload. A retry while pending calls the SDK's `resumeReceipt()` with the saved payload and match ID; a settled session makes no network request. Use `receipt finalize --session <id> --fallback download` after expiry when a prepared download is available. The prepared download and its secret URL live in a separate mode `0600` `<id>.download.json` file until the receipt settles. Protect the sessions directory accordingly.

If customer matching fails before a route is resolved, the session stays `DRAFT` and a retry attempts matching again. An uncertain download upload keeps its prepared upload for a retry. An active session lock is refreshed during long operations; a lock that has not been refreshed for 60 seconds is recovered, even across containers or after PID reuse.

Use `receipt list-products --session <id>` to inspect lines and `receipt remove-product --session <id> --line <identifier|one-based-index>` to remove one before finalization. Edits after finalization starts return `SESSION_FINALIZED`.

To call the Cheqi matching service before adding products:

```bash
CHEQI_API_KEY=sk_... cheqi session match \
  --session agent-a \
  --card-par YOUR_CARD_PAR
```

`session match` reports `routeFound`, `deliveryRouteType`, `matchId`, and `recipientCount`. Finalization resolves the route again before issuing the receipt so it never relies on a stale match.

## Direct JSON Workflow

```bash
CHEQI_API_KEY=sk_... npx @cheqi/cli receipts submit \
  --match-by card_par \
  --match-value YOUR_CARD_PAR \
  --receipt receipt.json
```

Use `--receipt -` to read the receipt JSON from stdin.

Run `cheqi receipts validate --receipt receipt.json` first to check a complete payload locally without authentication or a network request.

The JSON file must be a definitive SDK 2.5.0 `ReceiptPayload`. In particular, provide `issueDate`, all receipt totals, `taxesApplied`, and complete product values including `identifier`, `unitCode`, `subtotal`, and `total`. The CLI validates and normalizes the payload but does not infer missing merchant values.

For an anonymous matched flow that should resolve to a download fallback, use `--match-by payment_type --match-value CASH` (or `CARD_PAYMENT` / `DIRECT_DEBIT`).

To create an encrypted download receipt directly, without customer matching:

```bash
CHEQI_API_KEY=sk_... npx @cheqi/cli receipts submit-download \
  --receipt receipt.json \
  --payment-type CASH
```

The successful result includes `deliveryRouteType: "DOWNLOAD_FALLBACK"` and a `downloadUrl`. The URL fragment contains the decryption key; render or hand it to the customer and do not log it server-side.

Receipt results include `state`, `retryable`, and sometimes `retryAfterSeconds`. `DIGITAL_PENDING` returns a `RECEIPT_PENDING` error with the original `matchId`. For direct submissions, use `cheqi receipts resume --match-id <id> --receipt <same-file>` with exactly the original payload. For a session, retry `receipt finalize --session <id>`; it resumes automatically. A download URL is only customer-ready after acceptance. The SDK does not expose a public full prepare step for `receipts submit-download`, so an uncertain direct upload cannot be persisted before its first request by this CLI.

The direct flow has no saved download fallback after `RECEIPT_EXPIRED`; check the original outcome before starting another receipt. `receipt add-product` requires a positive quantity. `--fallback download` is available only after digital expiry or for a saved uncertain download upload.

## Machine-Readable Schema

Agents can discover commands, flags, valid enum values, and response names without parsing human help text:

```bash
cheqi schema
cheqi schema receipt validate
cheqi receipt add-product --help
```

Schema entries include `flags`, `positional`, and `responseSchema` so an agent can construct commands and validate expected output without probing the command first.

Run `cheqi skill` for the bundled agent skill as a JSON envelope, `cheqi skill --raw` for plain Markdown, or `cheqi skill install [--dir <skills-directory>]` to write `cheqi/SKILL.md` under `.claude/skills` by default. Use `--force` to replace a newer installed skill.

## Errors and retries

Exit `0` means success. Retryable failures exit `4`; authentication failures exit `3`; command, flag, and session usage failures exit `2`; other failures exit `1`. Every failure remains one JSON envelope on stdout. API error details can include `httpStatus`, `correlationId`, `sdkErrorCode`, and `retryAfterSeconds`.

| Code | Retryable | Exit | Meaning |
| --- | --- | ---: | --- |
| `AUTH_REQUIRED` | no | 3 | Authentication is required. |
| `AUTH_CONFLICT` | no | 3 | Choose one authentication method. |
| `COMMAND_NOT_FOUND` | no | 2 | The command does not exist. |
| `ENV_UNSUPPORTED` | no | 2 | The environment is unsupported. |
| `FLAG_INVALID` | no | 2 | A flag or value is invalid. |
| `FLAG_REQUIRED` | no | 2 | A required flag is missing. |
| `INPUT_INVALID` | no | 2 | Input cannot be parsed. |
| `RECEIPT_INVALID` | no | 1 | Receipt content is invalid. |
| `SESSION_INVALID` | no | 2 | The session ID or file is invalid. |
| `SESSION_NOT_FOUND` | no | 1 | The session does not exist. |
| `NETWORK_ERROR` | yes | 4 | The network request failed or timed out. |
| `RATE_LIMITED` | yes | 4 | The API rate limit was reached. |
| `API_UNAVAILABLE` | yes | 4 | The API timed out or is unavailable. |
| `API_REJECTED` | no | 1 | The API rejected the request. |
| `AUTH_INVALID` | no | 3 | The API rejected authentication. |
| `ENCRYPTION_FAILED` | no | 1 | Local receipt encryption failed. |
| `INTERNAL_ERROR` | no | 1 | An unexpected CLI error occurred. |
| `RECEIPT_PENDING` | yes | 4 | Submission is uncertain; resume the original match. |
| `RECEIPT_EXPIRED` | no | 1 | The original digital match expired. |
| `SESSION_FINALIZED` | no | 2 | The receipt payload is frozen. |
| `SESSION_LOCKED` | yes | 4 | The session is busy; retry shortly. |

Operational responses include a structured `nextStep` when another command is expected:

```json
{
  "command": ["receipt", "validate"],
  "requiredFlags": ["session"],
  "optionalFlags": [],
  "hint": "Validate locally before finalizing."
}
```

## Authentication

Use either:

```bash
CHEQI_API_KEY=sk_...
```

or:

```bash
CHEQI_ACCESS_TOKEN=...
```

Do not set both for the same command.

## Publishing

The GitHub Actions `Publish npm package` workflow publishes `@cheqi/cli` to npm. Run it manually with:

- `version`: the package version to publish, for example `0.4.0`
- `dist-tag`: `latest` or `next`

Before publishing, `@cheqi/sdk` must already exist on npm at a compatible version. In the npm settings for `@cheqi/cli`, configure a GitHub Actions trusted publisher with organization `cheqi-io`, repository `cheqi-cli`, workflow filename `publish-npm.yml`, and permission to run `npm publish`. The workflow uses GitHub's OIDC token; no `NPM_TOKEN` repository secret is needed. npm requires the repository and workflow names to match this setting exactly.

```bash
npm view @cheqi/sdk@2.5.0 version
npm view @cheqi/cli@0.4.0 version
```
