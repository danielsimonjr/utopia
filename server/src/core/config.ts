/**
 * Application configuration.
 *
 * Source order: environment variables with prefix UTOPIA_, then defaults.
 * Load `.env` before you call `loadConfig`.
 */

export type AppConfig = {
  databaseUrl: string;
  /** Connection string for migrations. If empty, use `databaseUrl`. */
  migrationUrl: string;
  bindAddr: string;
  jwtSecret: string | null;
  webDist: string;
  dataDir: string;
  dbMaxConnections: number;
  cookieSecure: boolean;
  openRegistration: boolean;
};

const DEFAULTS: AppConfig = {
  databaseUrl: "postgres://utopia:utopia@localhost:1517/utopia",
  migrationUrl: "",
  bindAddr: "0.0.0.0:1516",
  jwtSecret: null,
  webDist: "web/dist",
  dataDir: "data",
  dbMaxConnections: 32,
  cookieSecure: false,
  openRegistration: true,
};

function env(name: string): string | undefined {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") return undefined;
  return v;
}

function envBool(name: string, fallback: boolean): boolean {
  const v = env(name);
  if (v === undefined) return fallback;
  return v === "1" || v.toLowerCase() === "true";
}

function envInt(name: string, fallback: number): number {
  const v = env(name);
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(): AppConfig {
  const databaseUrl = env("UTOPIA_DATABASE_URL") ?? DEFAULTS.databaseUrl;
  const migrationUrl = env("UTOPIA_MIGRATION_URL") ?? "";
  return {
    databaseUrl,
    migrationUrl: migrationUrl || databaseUrl,
    bindAddr: env("UTOPIA_BIND_ADDR") ?? DEFAULTS.bindAddr,
    jwtSecret: env("UTOPIA_JWT_SECRET") ?? null,
    webDist: env("UTOPIA_WEB_DIST") ?? DEFAULTS.webDist,
    dataDir: env("UTOPIA_DATA_DIR") ?? DEFAULTS.dataDir,
    dbMaxConnections: envInt("UTOPIA_DB_MAX_CONNECTIONS", DEFAULTS.dbMaxConnections),
    cookieSecure: envBool("UTOPIA_COOKIE_SECURE", DEFAULTS.cookieSecure),
    openRegistration: envBool("UTOPIA_OPEN_REGISTRATION", DEFAULTS.openRegistration),
  };
}

export function parseBindAddr(addr: string): { hostname: string; port: number } {
  const last = addr.lastIndexOf(":");
  if (last < 0) return { hostname: "0.0.0.0", port: 1516 };
  return { hostname: addr.slice(0, last) || "0.0.0.0", port: Number(addr.slice(last + 1)) };
}
