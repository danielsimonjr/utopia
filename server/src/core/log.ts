/** Shared log helper. Write one JSON object per line. */

export type LogFields = Record<string, unknown>;

function write(level: string, msg: string, fields?: LogFields): void {
  const line = { level, msg, ts: new Date().toISOString(), ...fields };
  const text = JSON.stringify(line);
  if (level === "error") console.error(text);
  else console.log(text);
}

export const log = {
  info: (msg: string, fields?: LogFields) => write("info", msg, fields),
  warn: (msg: string, fields?: LogFields) => write("warn", msg, fields),
  error: (msg: string, fields?: LogFields) => write("error", msg, fields),
  debug: (msg: string, fields?: LogFields) => write("debug", msg, fields),
};
