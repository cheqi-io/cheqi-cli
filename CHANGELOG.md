# Changelog

## 0.4.0 — 2026-10-12

- Breaking: API, network, and pending receipt failures now have distinct error codes and exit codes. The CLI sets exit code `4` for retryable failures, `3` for authentication failures, `2` for usage failures, and `1` for other failures.
- Breaking: session files now use version 2 and save immutable issue state and payload. Version 1 files still load.
- Breaking: session IDs are validated instead of rewritten; only `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` is accepted.
- Breaking: undocumented camelCase and legacy aliases, including `documentNumber`, `issueDate`, `priceIncl`, `unitPrice`, `taxRate`, `apiKey`, `accessToken`, `cardPar`, and `sessionId`, are removed. Use the kebab-case flags shown by `cheqi schema`. `qty` and `sku` remain documented aliases.
- Breaking: unexpected failures now use `INTERNAL_ERROR` instead of `INPUT_INVALID`; pending digital submissions return `RECEIPT_PENDING` rather than a success envelope. An unaccepted download URL is never returned.
- Breaking: receipt preview now returns an absolute session file path in `session` and the full local state in `draft`.
- Adopt SDK 2.5.0 result states and options-object authentication. Pending session finalization resumes the original match and saved payload. Prepared downloads are stored in mode `0600` sidecar files.
- Add strict schema-driven flags, configurable sessions directory, per-session locks, product list and remove commands, direct receipt validation and resume commands, and the generated Cheqi agent skill.
- A recoverable matching outage leaves a session in `DRAFT`, allowing a retry to find the customer's digital route. Active finalizations refresh their locks, while stale locks are recovered regardless of PID. Direct expiry no longer suggests a session fallback, draft fallback requests fail clearly, uncertain uploads include a recovery hint, and product quantities must be positive.
