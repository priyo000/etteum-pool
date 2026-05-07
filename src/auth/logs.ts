export interface AuthLogEntry {
  id: number;
  timestamp: string;
  type: string;
  accountId?: number;
  email?: string;
  provider?: string;
  step?: string;
  message?: string;
  error?: string;
  data?: unknown;
}

const MAX_LOGS = 500;
let nextId = 1;
const logs = new Array<AuthLogEntry | undefined>(MAX_LOGS);
let start = 0;
let count = 0;

export function addAuthLog(entry: Omit<AuthLogEntry, "id" | "timestamp">): AuthLogEntry {
  const log: AuthLogEntry = {
    id: nextId++,
    timestamp: new Date().toISOString(),
    ...entry,
  };

  const writeIndex = (start + count) % MAX_LOGS;
  logs[writeIndex] = log;

  if (count < MAX_LOGS) {
    count += 1;
  } else {
    start = (start + 1) % MAX_LOGS;
  }

  return log;
}

export function getAuthLogs(limit = 100): AuthLogEntry[] {
  const boundedLimit = Math.max(0, Math.min(limit, count));
  const result: AuthLogEntry[] = [];

  for (let i = 0; i < boundedLimit; i++) {
    const index = (start + count - 1 - i) % MAX_LOGS;
    const log = logs[index];
    if (log) result.push(log);
  }

  return result;
}

export function clearAuthLogs(): void {
  logs.fill(undefined);
  start = 0;
  count = 0;
}
