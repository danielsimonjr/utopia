/**
 * Auth routes: register, login, logout, "who am I", profile, password.
 */

import type { Hono } from "hono";
import type { AppState } from "../../state";
import * as store from "../../store";
import * as auth from "../../auth";
import { AppError } from "../../core/errors";
import { publicUser } from "../../core/models";

type RegisterReq = {
  email?: unknown;
  password?: unknown;
  display_name?: unknown;
  org_name?: unknown;
};

type LoginReq = { email?: unknown; password?: unknown };

function validateRegister(req: RegisterReq): { email: string; password: string; displayName: string } {
  const email = typeof req.email === "string" ? req.email : "";
  const password = typeof req.password === "string" ? req.password : "";
  const displayName = typeof req.display_name === "string" ? req.display_name : "";
  if (!email.includes("@") || email.length > 254) {
    throw AppError.invalid("bad_email", "Invalid email address");
  }
  if ([...password].length < 8) {
    throw AppError.invalid("password_too_short", "Password must be at least 8 characters");
  }
  if (displayName.trim() === "" || [...displayName].length > 64) {
    throw AppError.invalid("bad_display_name", "Display name must be 1-64 characters");
  }
  return { email, password, displayName };
}

export function registerAuthRoutes(api: Hono, state: AppState): void {
  api.post("/auth/register", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as RegisterReq;
    const { email, password, displayName } = validateRegister(body);
    const hash = await auth.hashPassword(password);
    const orgName =
      typeof body.org_name === "string" && body.org_name.trim() !== "" ? body.org_name.trim() : null;

    const open = await store.access.openRegistration(state.sql).catch(() => state.openRegistration);
    const { user, workspace } = await store.accounts.register(
      state.sql,
      email.trim(),
      hash,
      displayName.trim(),
      orgName,
      open,
    );

    const token = await auth.issueToken(state, user.id);
    const secure = auth.behindTls(c.req.raw.headers, state.cookieSecure);
    auth.setAuthCookie(c, token, secure);
    await store.audit.record(state.sql, null, user.id, "auth.register", "user", user.id, {
      email: user.email,
      is_admin: user.is_admin,
    });
    return c.json({ user: publicUser(user), workspace, token });
  });

  async function recordLoginFailure(email: string, reason: string): Promise<void> {
    await store.audit.recordOpt(state.sql, null, null, "auth.login_failed", "user", null, {
      email,
      reason,
    });
  }

  api.post("/auth/login", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as LoginReq;
    const email = typeof body.email === "string" ? body.email.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";

    const user = await store.accounts.findUserByEmail(state.sql, email);
    if (!user) {
      await recordLoginFailure(email, "unknown_email");
      throw AppError.unauthorized();
    }
    if (!(await auth.verifyPassword(password, user.password_hash))) {
      await recordLoginFailure(email, "bad_password");
      throw AppError.unauthorized();
    }
    const token = await auth.issueToken(state, user.id);
    const secure = auth.behindTls(c.req.raw.headers, state.cookieSecure);
    auth.setAuthCookie(c, token, secure);
    await store.audit.record(state.sql, null, user.id, "auth.login", "user", user.id, {});
    return c.json({ user: publicUser(user), token });
  });

  api.post("/auth/logout", async (c) => {
    const token = auth.extractToken(c);
    if (token) {
      try {
        const userId = await auth.decodeUserId(state, token);
        await store.audit.record(state.sql, null, userId, "auth.logout", "user", userId, {});
      } catch {
        // An expired or invalid token still needs its cookie cleared.
      }
    }
    const secure = auth.behindTls(c.req.raw.headers, state.cookieSecure);
    auth.clearAuthCookie(c, secure);
    return c.json({ ok: true });
  });

  api.get("/auth/me", async (c) => {
    const user = await auth.requireUser(c, state);
    return c.json(publicUser(user));
  });

  api.patch("/auth/me", async (c) => {
    const user = await auth.requireUser(c, state);
    const body = (await c.req.json().catch(() => ({}))) as { display_name?: unknown };
    const name = (typeof body.display_name === "string" ? body.display_name : "").trim();
    if (name === "" || [...name].length > 64) {
      throw AppError.invalid("bad_display_name", "Display name must be 1-64 characters");
    }
    const updated = await store.accounts.updateDisplayName(state.sql, user.id, name);
    return c.json(publicUser(updated));
  });

  api.post("/auth/password", async (c) => {
    const user = await auth.requireUser(c, state);
    const body = (await c.req.json().catch(() => ({}))) as {
      current_password?: unknown;
      new_password?: unknown;
    };
    const current = typeof body.current_password === "string" ? body.current_password : "";
    const next = typeof body.new_password === "string" ? body.new_password : "";
    if (!(await auth.verifyPassword(current, user.password_hash))) {
      throw AppError.invalid("wrong_password", "Current password is incorrect");
    }
    if ([...next].length < 8) {
      throw AppError.invalid("password_too_short", "Password must be at least 8 characters");
    }
    const hash = await auth.hashPassword(next);
    await store.accounts.updatePassword(state.sql, user.id, hash);
    await store.audit.record(state.sql, null, user.id, "auth.password_changed", "user", user.id, {});
    return c.json({ ok: true });
  });
}
