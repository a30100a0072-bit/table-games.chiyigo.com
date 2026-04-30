# JWK Rotation SOP

The Worker is its own IdP. Tokens are signed with `JWT_PRIVATE_JWK` and
verified against the public JWKS at `/.well-known/jwks.json`. To rotate
without invalidating live sessions, both keys must coexist for one
token-TTL window (24 h by default — see `signJWT` in `src/utils/auth.ts`).

## When to rotate

- **Routine**: every 90 days.
- **Compromise**: any time you suspect the private JWK has leaked
  (developer machine stolen, CI logs accidentally printed it, etc.).
- **Algorithm migration**: only relevant if we ever move off ES256.

## Procedure (zero-downtime)

### Phase 1 — generate the new key

```bash
npm run gen:jwk          # prints a new EC P-256 JWK with a fresh kid
```

Save the JSON. Don't paste it anywhere yet.

### Phase 2 — publish both keys (new + old)

`JWT_PRIVATE_JWK` accepts an array. The **first entry signs**; every entry
verifies. Build the array `[NEW, OLD]` and push it as the new secret:

```bash
# `OLD` is whatever JWT_PRIVATE_JWK currently contains. Read once with:
npx wrangler secret list --env production
# (Cloudflare hides values; if you don't have OLD locally, regenerate
# the rotation pair with both NEW and "next-old" instead — old tokens
# will fail to verify but only for the few minutes until they expire.)

# Compose the array as a single-line JSON:
cat > /tmp/jwks.json <<EOF
[$NEW_JWK, $OLD_JWK]
EOF

# Push the secret. Wrangler reads from stdin.
cat /tmp/jwks.json | npx wrangler secret put JWT_PRIVATE_JWK --env production

# Verify the JWKS endpoint now serves both kids.
curl -s https://big-two-game-production.<subdomain>.workers.dev/.well-known/jwks.json | jq '.keys[].kid'
```

After this push, every new token is signed by NEW. Tokens issued before
the push (signed by OLD) still verify because OLD's public key is still
in the JWKS.

### Phase 3 — wait for one full token TTL

Default TTL is 24 h (`signJWT(sub, jwk, 86_400)`). After 24 h every
OLD-signed token is expired anyway, so removing OLD from the JWKS is
safe.

### Phase 4 — drop the old key

```bash
# JWT_PRIVATE_JWK becomes a single object again (back-compat with the
# pre-rotation format).
echo "$NEW_JWK" | npx wrangler secret put JWT_PRIVATE_JWK --env production

# Verify the JWKS endpoint now serves only the new kid.
curl -s https://big-two-game-production.<subdomain>.workers.dev/.well-known/jwks.json | jq '.keys[].kid'
```

Delete `/tmp/jwks.json` and any local copies of OLD.

## Rollback

If Phase 2 fails (e.g. the new key was malformed and `wrangler secret put`
landed bad JSON), the Worker fails closed at startup and `/auth/token`
returns 500. Recovery:

```bash
# Revert to the previous single-key value.
echo "$OLD_JWK" | npx wrangler secret put JWT_PRIVATE_JWK --env production
```

Live sessions keep working because their tokens were signed by OLD and
the JWKS continues to expose OLD's public key.

## Compromise scenario (skip Phase 3)

If OLD has leaked, you don't have 24 h to wait. Instead:

1. Phase 1 — generate NEW.
2. Phase 4 directly — push **only** NEW. Every existing OLD token
   instantly becomes invalid; users get re-prompted to log in. You
   trade UX for security.

Document the incident in `incident-log.md` (we don't have one yet —
create it on the first incident).

## Validation

After every rotation, run an end-to-end smoke test:

```bash
# 1. /auth/token issues a token signed by the active kid.
TOKEN=$(curl -s -X POST https://.../auth/token \
  -H "Content-Type: application/json" \
  -d '{"playerId":"rotcheck"}' | jq -r .token)

# 2. The token's kid (header decoded) matches the first key in JWKS.
echo "$TOKEN" | cut -d. -f1 | base64 -d 2>/dev/null | jq .kid
curl -s https://.../.well-known/jwks.json | jq '.keys[0].kid'

# 3. /api/me/wallet succeeds with the new token.
curl -s https://.../api/me/wallet -H "Authorization: Bearer $TOKEN"
```

If any of these fails, stop and roll back via the rollback steps above.
