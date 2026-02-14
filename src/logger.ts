export type LogLevel = "debug" | "info" | "warn" | "error";

export const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function getConfiguredLevel(): number {
  const envLevel = (process.env.LOG_LEVEL || "info").toLowerCase() as LogLevel;
  return LEVELS[envLevel] ?? LEVELS.info;
}

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string, error?: unknown): void;
}

export function createLogger(component: string): Logger {
  function emit(level: LogLevel, message: string, error?: unknown): void {
    if (LEVELS[level] < getConfiguredLevel()) return;

    const entry: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      level,
      component,
      message,
    };

    if (error instanceof Error) {
      entry.error = error.message;
      entry.stack = error.stack;
    } else if (error !== undefined) {
      entry.error = String(error);
    }

    const writer = level === "warn" || level === "error" ? console.error : console.log;
    writer(JSON.stringify(entry));
  }

  return {
    debug: (message: string) => emit("debug", message),
    info: (message: string) => emit("info", message),
    warn: (message: string) => emit("warn", message),
    error: (message: string, error?: unknown) => emit("error", message, error),
  };
}
