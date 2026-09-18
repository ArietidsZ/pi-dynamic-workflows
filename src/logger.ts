/**
 * Workflow logger with file persistence.
 */

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workflowProjectPaths } from "./workflow-paths.js";

export interface WorkflowLogger {
  log(message: string): void;
  error(message: string): void;
  warn(message: string): void;
  getLogs(): string[];
  persist(): string | null;
}

export interface WorkflowLoggerOptions {
  /** Run ID for persistence. */
  runId?: string;
  /** Working directory for file paths. */
  cwd?: string;
  /** Whether to persist logs to disk. */
  persist?: boolean;
  /** Callback for each log entry. */
  onLog?: (message: string) => void;
}

export function createWorkflowLogger(options: WorkflowLoggerOptions = {}): WorkflowLogger {
  const logs: string[] = [];
  const persistLogs = options.persist ?? true;
  const cwd = options.cwd ?? process.cwd();
  const runId = options.runId ?? `run-${Date.now()}`;
  const runsDir = workflowProjectPaths(cwd).runsDir;
  let logFile: string | null = null;
  // Lines already written to logFile — persist() appends only the pending
  // slice (audit2 #39): a full rewrite per persist doubles write volume, and
  // a RESUMED run's fresh logger would wipe the earlier execution's lines.
  let persistedUpTo = 0;

  const write = (level: string, message: string) => {
    const timestamp = new Date().toISOString();
    const entry = `[${timestamp}] [${level}] ${message}`;
    logs.push(entry);
    options.onLog?.(message);

    if (persistLogs && logFile) {
      try {
        appendFileSync(logFile, `${entry}\n`);
        // Written through: keep persist()'s pending slice from re-appending it.
        persistedUpTo = logs.length;
      } catch {
        // Silent fail for log persistence
      }
    }
  };

  const logger: WorkflowLogger = {
    log(message: string) {
      write("INFO", message);
    },
    error(message: string) {
      write("ERROR", message);
    },
    warn(message: string) {
      write("WARN", message);
    },
    getLogs() {
      return [...logs];
    },
    persist() {
      if (!persistLogs) return null;
      try {
        mkdirSync(runsDir, { recursive: true });
        logFile = join(runsDir, `${runId}.log`);
        const pending = logs.slice(persistedUpTo);
        if (pending.length > 0) {
          // Append, not rewrite: an earlier execution of this runId (pause /
          // resume) already wrote its lines to this file.
          appendFileSync(logFile, `${pending.join("\n")}\n`);
          persistedUpTo = logs.length;
        } else if (!existsSync(logFile)) {
          writeFileSync(logFile, "");
        }
        return logFile;
      } catch {
        return null;
      }
    },
  };

  // Initialize log file if persisting
  if (persistLogs) {
    try {
      mkdirSync(runsDir, { recursive: true });
      logFile = join(runsDir, `${runId}.log`);
    } catch {
      // Silent fail
    }
  }

  return logger;
}
