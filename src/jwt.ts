import { createPublicKey, type JsonWebKeyInput, verify } from "node:crypto";

export interface IdClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat: number;
  azp?: string;
  nonce?: string;
  email?: string;
  name?: string;
}

/** A public key from the issuer's key set (`jwks_uri`). */
export type Jwk = JsonWebKeyInput["key"] & { kid?: string };

export class TokenError extends Error {}

function part(value: string | undefined): Record<string, unknown> {
  if (!value) throw new TokenError("malformed token");
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new TokenError("malformed token");
  }
}

/** The key id and algorithm of a JWT, before it is verified. */
export function tokenHeader(token: string): { kid?: string; alg?: string } {
  const header = part(token.split(".")[0]);
  return {
    ...(typeof header.kid === "string" ? { kid: header.kid } : {}),
    ...(typeof header.alg === "string" ? { alg: header.alg } : {}),
  };
}

export interface VerifyOptions {
  issuer: string;
  audience: string;
  nonce?: string;
  /** Seconds since the epoch to check `exp` against (now by default). */
  now?: number;
}

/** Verifies an RS256 ID token with the issuer's key and checks its claims. */
export function verifyIdToken(token: string, key: Jwk, options: VerifyOptions): IdClaims {
  const [head, body, signature, ...rest] = token.split(".");
  if (!head || !body || !signature || rest.length) throw new TokenError("malformed token");
  if (tokenHeader(token).alg !== "RS256") throw new TokenError("unexpected signing algorithm");
  let publicKey: ReturnType<typeof createPublicKey>;
  try {
    publicKey = createPublicKey({ key: key, format: "jwk" });
  } catch {
    throw new TokenError("unusable signing key");
  }
  const valid = verify(
    "RSA-SHA256",
    Buffer.from(`${head}.${body}`),
    publicKey,
    Buffer.from(signature, "base64url"),
  );
  if (!valid) throw new TokenError("invalid signature");
  const claims = part(body);
  const now = options.now ?? Date.now() / 1000;
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== options.issuer) throw new TokenError("unexpected issuer");
  if (!audiences.includes(options.audience)) throw new TokenError("unexpected audience");
  if (audiences.length > 1 && claims.azp !== options.audience) {
    throw new TokenError("unexpected authorized party");
  }
  if (claims.azp !== undefined && claims.azp !== options.audience) {
    throw new TokenError("unexpected authorized party");
  }
  if (typeof claims.sub !== "string" || !claims.sub) throw new TokenError("no subject");
  if (typeof claims.exp !== "number" || claims.exp + 5 < now) throw new TokenError("expired");
  if (typeof claims.iat !== "number") throw new TokenError("no issue time");
  if (options.nonce !== undefined && claims.nonce !== options.nonce) {
    throw new TokenError("unexpected nonce");
  }
  return claims as unknown as IdClaims;
}
