import { db } from "../db/index";
import { accounts } from "../db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { broadcast } from "../ws/index";
import { addAuthLog } from "./logs";
import { warmupAccount, type WarmupResult } from "./warmup-runner";

type WarmupStatus = "queued" | "processing" | "completed" | "failed";

type QueueItem = {
  accountId: number;
  retries: number;
  status: WarmupStatus;
  addedAt: Date;
};

export interface WarmupAllOptions {
  providers?: string[];
  statuses?: string[];
  includePending?: boolean;
}

class WarmupQueue {
  private queue: QueueItem[] = [];
  private activeJobs = 0;
  private processing = false;
  private concurrency = 5;
  private readonly maxRetries = 2;
  private totalProcessed = 0;
  private totalSuccess = 0;
  private totalFailed = 0;

  enqueue(accountId: number): void {
    if (this.queue.some((item) => item.accountId === accountId && item.status !== "completed" && item.status !== "failed")) {
      return;
    }

    const item: QueueItem = { accountId, retries: 0, status: "queued", addedAt: new Date() };
    this.queue.push(item);

    const log = addAuthLog({
      type: "warmup_queue_added",
      accountId,
      message: `Account #${accountId} queued for WarmUp`,
    });
    broadcast({ type: "warmup_queue_added", data: { logId: log.id, accountId, message: log.message, timestamp: log.timestamp } });
    this.process();
  }

  enqueueBulk(accountIds: number[]): void {
    for (const id of accountIds) this.enqueue(id);
  }

  async queueAll(options: WarmupAllOptions = {}): Promise<number> {
    const providers = options.providers?.length ? options.providers : ["kiro", "codebuddy"];
    const statuses = options.statuses?.length
      ? options.statuses
      : options.includePending
        ? ["active", "exhausted", "error", "pending"]
        : ["active", "exhausted", "error"];

    const rows = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(inArray(accounts.provider, providers), inArray(accounts.status, statuses)));

    const ids = rows.map((row) => row.id);
    this.enqueueBulk(ids);
    return ids.length;
  }

  getStatus() {
    return {
      queued: this.queue.filter((item) => item.status === "queued").length,
      active: this.activeJobs,
      processing: this.processing,
      concurrency: this.concurrency,
      totalProcessed: this.totalProcessed,
      totalSuccess: this.totalSuccess,
      totalFailed: this.totalFailed,
      items: this.queue.map((item) => ({ ...item, addedAt: item.addedAt.toISOString() })),
    };
  }

  clear(): void {
    this.queue = this.queue.filter((item) => item.status === "processing");
    broadcast({ type: "warmup_queue_cleared", data: {} });
  }

  setConcurrency(concurrency: number): void {
    this.concurrency = Math.max(1, Math.min(20, concurrency));
    this.process();
  }

  private process(): void {
    if (this.processing) return;
    this.processing = true;
    void this.processLoop();
  }

  private async processLoop(): Promise<void> {
    try {
      while (this.activeJobs < this.concurrency) {
        const item = this.queue.find((entry) => entry.status === "queued");
        if (!item) break;
        item.status = "processing";
        this.activeJobs++;
        void this.processItem(item).finally(() => {
          this.activeJobs--;
          this.process();
        });
      }
    } finally {
      this.processing = false;
      if (this.activeJobs === 0 && !this.queue.some((item) => item.status === "queued" || item.status === "processing")) {
        broadcast({
          type: "warmup_complete",
          data: {
            totalProcessed: this.totalProcessed,
            totalSuccess: this.totalSuccess,
            totalFailed: this.totalFailed,
          },
        });
      }
    }
  }

  private async processItem(item: QueueItem): Promise<void> {
    const [account] = await db.select().from(accounts).where(eq(accounts.id, item.accountId));
    if (!account) {
      item.status = "failed";
      this.totalProcessed++;
      this.totalFailed++;
      return;
    }

    const log = addAuthLog({
      type: "warmup_processing",
      accountId: account.id,
      email: account.email,
      provider: account.provider,
      step: "queued_check",
      message: `WarmUp processing ${account.provider}/${account.email}`,
    });
    broadcast({
      type: "warmup_processing",
      data: {
        logId: log.id,
        accountId: account.id,
        id: account.id,
        email: account.email,
        provider: account.provider,
        attempt: item.retries + 1,
        remaining: this.queue.filter((entry) => entry.status === "queued").length,
        message: log.message,
        timestamp: log.timestamp,
      },
    });

    try {
      const result = await warmupAccount(account);
      if (result.retryable && item.retries < this.maxRetries) {
        item.retries++;
        item.status = "queued";
        await this.delay(this.backoffMs(item.retries));
        return;
      }

      item.status = result.success || result.kind === "unsupported" || result.kind === "transient_error" ? "completed" : "failed";
      this.totalProcessed++;
      if (result.success) this.totalSuccess++;
      else this.totalFailed++;
    } catch (error) {
      if (item.retries < this.maxRetries) {
        item.retries++;
        item.status = "queued";
        await this.delay(this.backoffMs(item.retries));
        return;
      }

      item.status = "failed";
      this.totalProcessed++;
      this.totalFailed++;
      const message = error instanceof Error ? error.message : String(error);
      const failLog = addAuthLog({
        type: "warmup_auth_error",
        accountId: account.id,
        email: account.email,
        provider: account.provider,
        error: message,
        message,
      });
      broadcast({
        type: "warmup_auth_error",
        data: { logId: failLog.id, accountId: account.id, id: account.id, email: account.email, provider: account.provider, error: message, timestamp: failLog.timestamp },
      });
    }
  }

  private backoffMs(retries: number): number {
    const base = Math.min(10000, 2000 * 2 ** Math.max(0, retries - 1));
    return base + Math.floor(Math.random() * 500);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export const warmupQueue = new WarmupQueue();
