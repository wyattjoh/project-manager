import { environment } from "@raycast/api";

type Logger = (format: string, ...args: unknown[]) => void;

const NOOP: Logger = () => {};

export function createLogger(namespace: string): Logger {
  if (!environment.isDevelopment) {
    return NOOP;
  }

  return (format, ...args) => {
    console.log(`[${namespace}] ${format}`, ...args);
  };
}
