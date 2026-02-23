export enum LogLevel {
  DEBUG,
  INFO,
  WARN,
  ERROR,
}

export interface Logger extends Console {
  level: LogLevel;
  setLevel(level: LogLevel): void;
}

export const createLogger: (level: LogLevel) => Logger = (level) => ({
  ...console,
  level: level,
  debug(msg: any, ...args: any[]) {
    if (this.level <= LogLevel.DEBUG) {
      console.debug(msg, ...args);
    }
  },
  log(msg: any, ...args: any[]) {
    if (this.level <= LogLevel.INFO) {
      console.info(msg, ...args);
    }
  },
  info(msg: any, ...args: any[]) {
    if (this.level <= LogLevel.INFO) {
      console.info(msg, ...args);
    }
  },
  warn(msg: any, ...args: any[]) {
    if (this.level <= LogLevel.WARN) {
      console.warn(msg, ...args);
    }
  },
  error(msg: any, ...args: any[]) {
    if (this.level <= LogLevel.ERROR) {
      console.error(msg, ...args);
    }
  },

  setLevel(level: LogLevel) {
    this.level = level;
  },
});

/** defaults based on env - overridden in the UI with keybind "d" */
export let logger = createLogger(import.meta.env.DEV ? LogLevel.INFO : LogLevel.ERROR);
