# 0006. Authorize publishers against the backend

- **Status:** Proposed
- **Date:** 2026-11-19
- **Deciders:** HCF Engineering (team lead to confirm)

## Context

Anyone who can reach port 1935 can publish to `/live/<anything>`; the output is transcoded and served publicly.
The backend already knows the active stream key (`GET /api/v1/streams/getActiveLiveStream`), but the server uses it
to *choose* an output path rather than to *check* the publisher ([KNOWN_ISSUES #2, #6](../KNOWN_ISSUES.md)).

node-media-server v4 constraints (from the 4.2.8 source):

- `prePublish` is emitted synchronously; an `async` listener cannot delay or block the publish.
- A session can be rejected at any time with `session.close()`.
- Built-in `auth.publish` supports signed URLs: `?sign=<expiry>-<md5(streamPath-expiry-secret)>`.
- Built-in `notify.url` POSTs every event to a URL and closes the session on a non-200 reply. It also fires for
  our own FFmpeg play sessions, and labels `prePublish` as `postPublish`.

## Decision

In the `postPublish` handler:

1. Read the key the encoder used: `session.streamName`.
2. Ask the backend whether that key is the active one (existing endpoint, or a new `validate` endpoint).
3. If not valid, or the backend is unreachable after retries: `session.close()`, log it, and **do not** start FFmpeg.
4. If valid: start HLS + MP4 for `session.streamPath`.

Remove the fallback key `1970-teststream` for production. Keep it only behind a dev/test flag.

## Consequences

- ✅ Only the scheduled broadcast can go live; the backend stays the source of truth.
- ✅ Fixes the mismatch where OBS's key was ignored.
- ⚠️ If the backend is down, nobody can go live. This is the safe default; a configurable "allow on backend failure"
  flag can be added for emergencies.
- ⚠️ The stream starts a few hundred milliseconds later (one HTTP call).

## Alternatives considered

- **Built-in signed URLs (`auth.publish`).** No backend call at publish time, but someone must generate and rotate
  signed URLs for the media team. Good option if the backend can produce them.
- **`notify.url` webhook.** Built in, but couples the backend to every play/publish event, including our own FFmpeg
  connections, and has the mislabelled event.
- **Network restriction (firewall / VPN to 1935).** Useful extra layer; not sufficient alone if encoders move between locations.
