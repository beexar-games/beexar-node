# Changelog

All notable changes to `@beexar/sdk`. The version is shared across the Beexar
SDKs for Node, PHP, Go and Python — the same number always means the same
contract snapshot.

## 1.2.0 — 2026-10-23

Operator freespins, the SoftSwiss Freespins API one to one. Additions only: a
wallet that does not issue freespins needs no change.

- `Client.issueFreespins`, `Client.cancelFreespins` and `Client.betLevels` —
  Freespins/Issue, Freespins/Cancel and Bet/Levels, signed over the exact bytes
  like the launch calls. Their types: `FreespinsIssueRequest`,
  `FreespinsCancelRequest`, `BetLevelsRequest`, `BetLevelData`,
  `CurrencyBetLevels`, `BetLevel`.
- `/freespins/finish`, the fifth callback: the optional
  `WalletHandler.freespinsFinish` receives a `FreespinsFinishRequest` (`amount`
  as `Money`, zero allowed) and answers a `FreespinsFinishResult`. A handler
  without it answers that route like an unknown one.
- `WalletError.invalidFreespinsIssue` (api_code 610) and
  `WalletError.freespinsStateTransition` (605); the freespins api_codes in
  `ApiCode`.
- `ApiCode.FEATURE_NOT_SUPPORTED` (608): `issueFreespins` answers it for a game
  that plays no freespins, and `ApiCode.GAME_NOT_AVAILABLE` (405) for a game
  your casino does not have; 601 is left for a missing bet level. 406 reads
  "This feature is not enabled for your casino" (the SoftSwiss registry of
  2026-10-25).
- `Route` and `ROUTES` gain `'/freespins/finish'`; the Fastify plugin registers
  it with the other four.
- `routeFromPath` matches the longest route first. `/freespins/finish` ends with
  `/finish` too, and must not reach the round's finish handler.
- The reference wallet credits a freespins result once per `issue_id`, and the
  conformance fixtures (version 2) cover it.
- A malformed `X-REQUEST-SIGN` of the right length but not hex — 64 Latin-1
  letters, say — is refused like any bad signature (HTTP 400, api_code 403). It
  used to surface as an HTTP 500 from a `RangeError` inside the constant-time
  comparison, which the platform treats as retryable. `verify` now requires 64
  lowercase hex characters before comparing. Conformance fixtures version 3 add
  `0033-signature-non-ascii`.
- The game catalog no longer lists the built-in slots game, removed on
  2026-10-24: `category` is `dice`, `plinko`, `crash` or `rgs`. `has_freespins`
  reports a game's own in-game free spins, not operator freespins; no game
  sets it today.

## 1.1.0 — 2026-10-04

Node 22 or newer, up from 18: Node 18 and 20 are past end of life upstream. No
change to the API.

- `Client` no longer checks for a global `fetch` when it is built — every
  supported Node has one. `options.fetch` still replaces it.

## 1.0.2 — 2026-09-18

No change to the code you consume. 1.0.1 reached PyPI, Packagist and the Go
proxy but not npm: the publish workflow pinned `npm@latest`, which had moved to
a major that refuses to run on the Node version the workflow used.

## 1.0.1 — 2026-09-18

No change to the code you consume. The release exists to move publishing onto
npm's and PyPI's trusted publishing, so no long-lived registry token is stored
anywhere any more.

## 1.0.0 — 2026-09-18

First public release.

- `Client` — `launchReal`, `launchDemo`, `listGames`, signed with HMAC-SHA256
  over the exact request bytes.
- `WalletServer` — the four seamless-wallet callbacks as one pure
  `dispatch(route, rawBody, signature)`.
- Bindings for Express/Connect, Fastify and `node:http`, each dealing with that
  framework's own way of destroying the raw body.
- `Money` — decimal-string amounts that cannot be built from a `number`.
- `WalletError` — the full api_code registry, with the balance a required
  argument for codes 100, 105 and 106.
- Types generated from the OpenAPI specs and pinned to them at compile time.
