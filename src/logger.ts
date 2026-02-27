const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type LogLevel = keyof typeof LEVELS;

let current: LogLevel = "info";

function isLevel(s: string): s is LogLevel {
  return s in LEVELS;
}

export function setLevel(level: string): void {
  if (isLevel(level)) current = level;
}

function log(level: LogLevel, tag: string, ...args: unknown[]): void {
  if (LEVELS[level] < LEVELS[current]) return;
  const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.error;
  fn(`[${tag}]`, ...args);
}

export const logger = {
  debug: (tag: string, ...args: unknown[]) => log("debug", tag, ...args),
  info: (tag: string, ...args: unknown[]) => log("info", tag, ...args),
  warn: (tag: string, ...args: unknown[]) => log("warn", tag, ...args),
  error: (tag: string, ...args: unknown[]) => log("error", tag, ...args),
};
