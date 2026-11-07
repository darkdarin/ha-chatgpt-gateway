import { LOG_LEVELS, type LogLevel } from "./config.ts";

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warning(message: string): void;
  error(message: string): void;
}

/** A plain logger for the app log. Never pass it tokens, API keys or request contents. */
export function createLogger(level: LogLevel, write = (line: string) => console.log(line)): Logger {
  const threshold = LOG_LEVELS.indexOf(level);
  const at =
    (name: LogLevel) =>
    (message: string): void => {
      if (LOG_LEVELS.indexOf(name) >= threshold) write(`${name.toUpperCase()}: ${message}`);
    };
  return { debug: at("debug"), info: at("info"), warning: at("warning"), error: at("error") };
}
