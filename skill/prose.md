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
