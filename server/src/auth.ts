/**
 * Authentication: argon2id password hashing + JWT (HttpOnly cookie, also
 * accepts a Bearer header). The cookie is a session cookie; expiry is
 * governed by the JWT's own `exp` (7 days).
 */

import { randomBytes } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { getCookie, setCookie } from "hono/cookie";
import type { Context } from "hono";
import { AppError } from "./core/errors";
import type { Uuid } from "./core/ids";
import type { User } from "./core/models";
import * as store from "./store";
import type { AppState } from "./state";

export const COOKIE_NAME = "utopia_token";
const TOKEN_TTL = "7d";

export async function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: "argon2id" });
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await Bun.password.verify(password, hash);
  } catch {
    return false;
  }
}

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function issueToken(state: AppState, userId: Uuid): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(TOKEN_TTL)
    .sign(secretKey(state.jwtSecret));
}

export async function decodeUserId(state: AppState, token: string): Promise<Uuid> {
  try {
    const { payload } = await jwtVerify(token, secretKey(state.jwtSecret));
    if (typeof payload.sub !== "string" || payload.sub === "") {
      throw new Error("token has no subject");
    }
    return payload.sub;
  } catch {
    throw AppError.unauthorized();
  }
}

/**
 * Whether the outer layer is running TLS. A reverse proxy sends
 * `X-Forwarded-Proto`; with no proxy (local, dev), assume plaintext so
 * login still works without Secure blocking the cookie.
 */
export function behindTls(headers: Headers, forced: boolean): boolean {
  if (forced) return true;
  const proto = headers.get("x-forwarded-proto");
  if (!proto) return false;
  const first = proto.split(",")[0]?.trim().toLowerCase();
  return first === "https";
}

export function setAuthCookie(c: Context, token: string, secure: boolean): void {
  setCookie(c, COOKIE_NAME, token, {
    path: "/",
    httpOnly: true,
    secure,
    sameSite: "Lax",
  });
}

/** The delete instruction for logout. Attributes must match the ones used at issuance, or the browser will not recognize which cookie to drop. */
export function clearAuthCookie(c: Context, secure: boolean): void {
  setCookie(c, COOKIE_NAME, "", {
    path: "/",
    httpOnly: true,
    secure,
    sameSite: "Lax",
    maxAge: 0,
  });
}

/** 32 random bytes, hex-encoded (64 characters). Hex, not base64: this value shows up in logs, env vars, and ops copy-paste, and hex has no characters that need escaping. */
export function generateJwtSecret(): string {
  return randomBytes(32).toString("hex");
}

/** Reads the token from the `utopia_token` cookie, or an `Authorization: Bearer` header. */
export function extractToken(c: Context): string | null {
  const cookie = getCookie(c, COOKIE_NAME);
  if (cookie) return cookie;
  const auth = c.req.header("authorization");
  if (auth?.startsWith("Bearer ")) {
    const token = auth.slice("Bearer ".length).trim();
    if (token !== "") return token;
  }
  return null;
}

/** Signed-in user extractor: cookie `utopia_token` or `Authorization: Bearer`. */
export async function requireUser(c: Context, state: AppState): Promise<User> {
  const token = extractToken(c);
  if (!token) throw AppError.unauthorized();
  const userId = await decodeUserId(state, token);
  const user = await store.accounts.findUserById(state.sql, userId);
  if (!user) throw AppError.unauthorized();
  return user;
}
