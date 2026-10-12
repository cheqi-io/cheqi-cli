# Cheqi CLI

Agent-friendly CLI wrapper around `@cheqi/sdk`.

The CLI uses the SDK 2.2.1 definitive receipt flow: it resolves a delivery route from the supplied identification details, encrypts the exact merchant-supplied receipt payload for that route, and issues it without a server-side receipt-template step.

Every command returns a JSON envelope on stdout:

```json
{
  "ok": true,
  "data": {},
  "meta": {
    "durationMs": 12,
    "version": "0.3.1"
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
    "version": "0.3.1"
  }
}
```

## Browser login

```bash
cheqi auth login --env sandbox
cheqi auth status --env sandbox
cheqi receipts submit --receipt receipt.json --match-by payment_type --match-value CASH
cheqi auth logout --env sandbox
```

`auth login` opens Cheqi's approval page. Sign in and select one company where you are an administrator. The browser redirects to a temporary `127.0.0.1` port opened by the CLI. The CLI checks the authorization state, exchanges the one-time code with PKCE, and saves the company-bound credentials in `~/.config/cheqi/credentials/` with owner-only permissions. A login is tied to its API endpoint; use `--env test` or `--env production` for other environments, or `--endpoint` for a local API. You can preselect a company with `--company-id`.

For a headless shell, pass `--no-browser` and open the authorization URL printed on stderr in a browser on the same computer.

The access token lasts 15 minutes. Commands refresh it automatically and rotate the refresh token before sending API requests. The login expires after 30 days, or sooner if revoked or your company administrator access is removed. Run `cheqi auth login` again then. `auth logout` revokes the backend session and removes local credentials. A new login for the same environment replaces the local session.

Explicit `--api-key`, `--access-token`, `CHEQI_API_KEY`, and `CHEQI_ACCESS_TOKEN` still work and take precedence over saved CLI credentials. Commands emit JSON only on stdout; browser instructions go to stderr.

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

Drafts are stored locally in `.cheqi/sessions/<session-id>.json`. Sessions are always explicit; pass `--session` on every command so concurrent agents do not share implicit state.

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

The JSON file must be a definitive SDK 2.5.0 `ReceiptPayload`. In particular, provide `issueDate`, all receipt totals, `taxesApplied`, and complete product values including `identifier`, `unitCode`, `subtotal`, and `total`. The CLI validates and normalizes the payload but does not infer missing merchant values.

For an anonymous matched flow that should resolve to a download fallback, use `--match-by payment_type --match-value CASH` (or `CARD_PAYMENT` / `DIRECT_DEBIT`).

To create an encrypted download receipt directly, without customer matching:

```bash
CHEQI_API_KEY=sk_... npx @cheqi/cli receipts submit-download \
  --receipt receipt.json \
  --payment-type CASH
```

The successful result includes `deliveryRouteType: "DOWNLOAD_FALLBACK"` and a `downloadUrl`. The URL fragment contains the decryption key; render or hand it to the customer and do not log it server-side.

Receipt results also include `state` and `retryable`. If `accepted` is false and `preparedDownload` is present, retain the entire `preparedDownload` object (including its URL and encrypted upload request). The SDK can retry that exact upload with `receiptService.uploadPreparedDownload(preparedDownload)`. Do not give the URL to the customer until the upload is accepted. For `DIGITAL_PENDING`, retain `matchId` and check the original match with the SDK before attempting another submission.

## Machine-Readable Schema

Agents can discover commands, flags, valid enum values, and response names without parsing human help text:

```bash
cheqi schema
cheqi schema receipt validate
cheqi receipt add-product --help
```

Schema entries include `flags`, `positional`, and `responseSchema` so an agent can construct commands and validate expected output without probing the command first.

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

- `version`: the package version to publish, for example `0.3.1`
- `dist-tag`: `latest` or `next`

Before the CLI can be published, `@cheqi/sdk` must already exist on npm at a compatible version. Configure the repository secret `NPM_TOKEN` with publish access for the `@cheqi/cli` package.

```bash
npm view @cheqi/sdk@2.5.0 version
npm view @cheqi/cli@0.3.1 version
```
