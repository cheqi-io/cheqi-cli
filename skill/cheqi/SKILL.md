---
name: cheqi
description: Use when issuing or validating Cheqi digital receipts from a shell.
cli-version: 0.4.0
---

# Cheqi CLI for agents

Use the CLI to issue or validate Cheqi digital receipts from a shell. Every ordinary command emits one JSON envelope on stdout. Read `ok`, `error.code`, `error.retryable`, `error.details`, and the process exit code before choosing a next step. Run `cheqi schema <command>` for full flag details.

## Choose a flow

- Use `session create`, `receipt add-product`, `receipt validate`, then `receipt finalize` when building a receipt line by line. Pass `--session` every time.
- Use `receipts validate` and `receipts submit` for a complete definitive JSON payload and a customer identifier.
- Use `receipts submit-download` for a complete payload without customer identity. Give the accepted QR download link to the customer.

## Receipt rules

- `--price-incl` is the gross unit price; `--unit-price` is the net unit price. VAT is a percentage, such as `21`.
- The CLI never invents missing merchant values in a direct definitive payload.
- `DIGITAL` delivers to a matched device. `DOWNLOAD_FALLBACK` requires a customer download or QR handoff. `EMAIL_FALLBACK` requires a separate email flow.
- `DIGITAL_SUBMITTED` is accepted. `DIGITAL_PENDING` is uncertain. `DIGITAL_EXPIRED` means the original match cannot complete. A settled `DOWNLOAD_FALLBACK` or `EMAIL_FALLBACK` indicates the corresponding handoff.

## Safety and recovery

- Never log, persist, or echo a `downloadUrl` yourself. Its URL fragment is the decryption key. Only show an accepted link to the customer.
- When `RECEIPT_PENDING` comes from a session, wait `retryAfterSeconds` if given and retry `receipt finalize --session <id>`. It resumes the saved match and payload.
- When customer matching fails before a route is resolved, the session stays `DRAFT`. Retry finalize to attempt digital matching again; an unaccepted QR URL is not shown.
- When `RECEIPT_PENDING` comes from `receipts submit`, use `receipts resume --match-id <id> --receipt <same path|->` with the exact original payload.
- A direct flow has no saved download fallback after `RECEIPT_EXPIRED`. Check the original outcome before starting a new receipt.
- Default to `sandbox`. Prefer `CHEQI_API_KEY` or `CHEQI_ACCESS_TOKEN` over putting secrets in command arguments.
- Retry `NETWORK_ERROR`, `RATE_LIMITED`, `API_UNAVAILABLE`, `RECEIPT_PENDING`, and `SESSION_LOCKED` with backoff. Respect `retryAfterSeconds`.
- Fix flags, session IDs, and receipt content for input errors. Stop and ask a human for invalid authentication, encryption failure, or an unexpected internal error.
- A prepared download is held in a mode `0600` sidecar file until the receipt settles. Treat the sessions directory as sensitive storage.

## Command index

| Command | Summary | Required flags |
| --- | --- | --- |
| `cheqi schema` | Inspect the machine-readable command and error contract. | none |
| `cheqi version` | Return the CLI version. | none |
| `cheqi help` | Return the machine-readable command schema. | none |
| `cheqi session create` | Create a local receipt session. | --session |
| `cheqi session match` | Match a customer for an existing session. | --session |
| `cheqi session status` | Inspect local session state. | --session |
| `cheqi session reset` | Delete a local session. | --session |
| `cheqi receipt set` | Update receipt-level fields. | --session |
| `cheqi receipt add-product` | Append a product line to a local receipt draft. | --session |
| `cheqi receipt remove-product` | Remove a product line by identifier or one-based index. | --session, --line |
| `cheqi receipt list-products` | List the current product lines. | --session |
| `cheqi receipt preview` | Return the full local session draft. | --session |
| `cheqi receipt validate` | Validate local receipt state without network side effects. | --session |
| `cheqi receipt finalize` | Submit an existing local session receipt. | --session |
| `cheqi receipts submit` | Submit a receipt JSON file or stdin without creating a local session. | --receipt, --match-by, --match-value |
| `cheqi receipts validate` | Validate a definitive receipt JSON payload without authentication or network access. | --receipt |
| `cheqi receipts resume` | Resume a pending direct digital submission using its original match ID and payload. | --match-id, --receipt |
| `cheqi receipts submit-download` | Issue a receipt via a client-generated, E2E-encrypted download link (no customer matching). The QR-ready URL carries the decryption key in its #fragment. | --receipt |
| `cheqi skill` | Return the bundled agent skill as JSON or raw Markdown. | none |
| `cheqi skill install` | Install the bundled agent skill into a local skills directory. | none |

Run `cheqi schema <command>` for full flag descriptions and response details.

## Error codes

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
