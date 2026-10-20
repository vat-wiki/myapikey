# Changelog

## v1.1.0 — 2026-10-20

- **systemone route surface:** TypeSafe System One (EdgeOne Makers structured evaluation) becomes a fourth independent protocol — new `systemone` format and route key, per-provider `baseUrlSystemone`, `/v1/systemone` forwarding endpoint, and a config migration (v6 → v7) filling in the new field. Served at `/v1/systemone`; requests are forwarded as a verbatim JSON POST (no chat, no streaming).
- **Hung-call guards:** `MYAPIKEY_TTFB_TIMEOUT_MS` (default 120000) aborts an upstream that never sends response headers; `MYAPIKEY_STREAM_IDLE_MS` (default 120000) closes a stream that stops flowing mid-body. Set either to `0` to disable.
- **Hang-up visibility:** client disconnects are recorded as `499` rows in the call history.

## v1.0.1 — 2026-10-08

- **First-login password setup:** the web admin password can be set on first login.

## v1.0.0 — 2026-09-29

- **Single-package layout:** the `packages/core` + `packages/web` monorepo collapses into one package — `myapikey` ships the server, shared code, and the built web UI together (`bin: myapikey`).
- Simplified READMEs and Dockerfile for the new layout.

> Earlier releases (v0.2.0 – v0.48.3) predate this changelog; see the git history for details.
