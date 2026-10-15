import { redact } from "./redact";

type Fields = Record<string, unknown>;

function emit(level: "info" | "warn" | "error", event: string, fields: Fields): void {
  const line = JSON.stringify({ level, event, at: new Date().toISOString(), ...(redact(fields) as Fields) });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}

/**
 * Structured JSON logs. Fields pass through `redact`, but callers must still
 * never pass credentials, OAuth codes, session tokens or email content.
 */
export const log = {
  info: (event: string, fields: Fields = {}) => emit("info", event, fields),
  warn: (event: string, fields: Fields = {}) => emit("warn", event, fields),
  error: (event: string, fields: Fields = {}) => emit("error", event, fields),
};
