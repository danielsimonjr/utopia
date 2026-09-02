/**
 * Application errors.
 *
 * The UI uses `code` to select a local string.
 * `message` is English. MCP, CLI, and logs use `message`.
 * The server does not store a locale. See decision 0004.
 */

export type AppErrorKind =
  | "NotFound"
  | "Unauthorized"
  | "Forbidden"
  | "Conflict"
  | "Validation"
  | "Invalid"
  | "Db"
  | "Other";

export class AppError extends Error {
  readonly kind: AppErrorKind;
  readonly code?: string;
  readonly detail?: string;
  readonly httpStatus: number;

  private constructor(
    kind: AppErrorKind,
    message: string,
    httpStatus: number,
    extra?: { code?: string; detail?: string },
  ) {
    super(message);
    this.kind = kind;
    this.httpStatus = httpStatus;
    this.code = extra?.code;
    this.detail = extra?.detail;
  }

  static notFound(): AppError {
    return new AppError("NotFound", "Not found", 404);
  }

  static unauthorized(): AppError {
    return new AppError("Unauthorized", "Not signed in or invalid credentials", 401);
  }

  static forbidden(): AppError {
    return new AppError("Forbidden", "You do not have permission to do that", 403);
  }

  static conflict(message: string): AppError {
    return new AppError("Conflict", message, 409);
  }

  static validation(message: string): AppError {
    return new AppError("Validation", message, 422);
  }

  static invalid(code: string, message: string, detail?: string): AppError {
    return new AppError("Invalid", message, 422, { code, detail });
  }

  static db(cause: unknown): AppError {
    const message = cause instanceof Error ? cause.message : String(cause);
    return new AppError("Db", message, 500);
  }

  static other(cause: unknown): AppError {
    const message = cause instanceof Error ? cause.message : String(cause);
    return new AppError("Other", message, 500);
  }

  toJson(): { error: string; code?: string; detail?: string } {
    const body: { error: string; code?: string; detail?: string } = {
      error: this.kind === "Db" || this.kind === "Other" ? "Internal server error" : this.message,
    };
    if (this.code) body.code = this.code;
    if (this.detail) body.detail = this.detail;
    return body;
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}
