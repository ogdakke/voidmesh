export const enum LogLevel {
  DEBUG,
  INFO,
  WARN,
  ERROR,
}

export interface Logger extends Console {
  level: LogLevel;
  setLevel(level: LogLevel): void;
}

type ConsoleMethod = (...args: any[]) => void;

const noop: ConsoleMethod = () => {};

export const createLogger: (level: LogLevel) => Logger = (level) => {
  const logger = Object.create(console) as Logger;
  const methods = {
    debug: console.debug.bind(console),
    log: console.info.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  } satisfies Record<"debug" | "log" | "info" | "warn" | "error", ConsoleMethod>;

  logger.setLevel = (nextLevel: LogLevel) => {
    logger.level = nextLevel;
    logger.debug = nextLevel <= LogLevel.DEBUG ? methods.debug : noop;
    logger.log = nextLevel <= LogLevel.INFO ? methods.log : noop;
    logger.info = nextLevel <= LogLevel.INFO ? methods.info : noop;
    logger.warn = nextLevel <= LogLevel.WARN ? methods.warn : noop;
    logger.error = nextLevel <= LogLevel.ERROR ? methods.error : noop;
  };

  logger.setLevel(level);

  return logger;
};

/** defaults based on env - overridden in the UI with keybind "d" */
export let logger = createLogger(import.meta.env.DEV ? LogLevel.INFO : LogLevel.ERROR);
