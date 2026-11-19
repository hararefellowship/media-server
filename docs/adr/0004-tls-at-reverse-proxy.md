# 0004. Terminate TLS at a reverse proxy, not in Node

- **Status:** Proposed
- **Date:** 2026-11-19
- **Deciders:** HCF Engineering (team lead to confirm)

## Context

`hcf-media-svr-test.js` loads Let's Encrypt certificates from a hard-coded host path and serves HTTPS on 8443.

- The path is not mounted into the container, so the server crashes on startup ([KNOWN_ISSUES #1](../KNOWN_ISSUES.md#1-production-entrypoint-crashes-on-startup)).
- The domain is hard-coded (`test.hararechristianfellowship.org`), so the same image can't serve another environment.
- Certificates are read once at startup; after Let's Encrypt renews them (every ~60–90 days) the process keeps
  serving the old certificate until restarted.
- Websites on `https://` can't load HLS from `http://` (mixed content), so viewers do need HTTPS.

## Decision

Serve HLS over **plain HTTP inside the host**, and put a **reverse proxy** (nginx or Caddy) in front that:

- terminates TLS on 443 with automatic certificate renewal,
- forwards to `localhost:8000`,
- sets caching headers (`.m3u8` short / no-cache, `.m4s` long-lived) and CORS if needed,
- can later be replaced or fronted by a CDN without touching this service.

Remove the HTTPS code from the Node server.

RTMP ingest stays on 1935. If encrypted ingest is needed, node-media-server v4 supports **RTMPS** (`rtmps` config, default port 1936).

## Consequences

- ✅ No certificate handling in application code; one image works in every environment.
- ✅ Renewals are handled by the proxy (Caddy does it automatically; nginx with certbot).
- ⚠️ One more component to deploy (a small container or host service).

## Alternatives considered

- **Keep HTTPS in Node, mount certs, read path from env.** Works, but still needs a restart or file-watch on renewal,
  and duplicates what a proxy does better.
- **CDN with TLS (e.g. CloudFront, Cloudflare) directly in front of :8000.** Good later step for scale; still benefits from a proxy as origin.
