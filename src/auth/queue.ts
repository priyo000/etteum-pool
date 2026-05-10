import { db } from "../db/index";
import { accounts } from "../db/schema";
import { eq, inArray } from "drizzle-orm";
import { loginAccount, loginAllProviders } from "./runner";
import { encrypt } from "../utils/crypto";
import { broadcast } from "../ws/index";
import type { Account } from "../db/schema";
import { addAuthLog } from "./logs";

interface QueueItem {
  accountId: number;
  retries: number;
  headless?: boolean;
  generation: number;
}

interface BulkAddItem {
  email: string;
  password: string;
  providers: string[]; // ["kiro", "codebuddy", "canva"]
}

class LoginQueue {
  private queue: QueueItem[] = [];
  private processing = false;
  private concurrency = 2; // Max concurrent logins
  private activeJobs = 0;
  private maxRetries = 3;
  private totalProcessed = 0;
  private totalSuccess = 0;
  private totalFailed = 0;
  private activeAccountIds = new Set<number>();
  private retryTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private clearGeneration = 0;

  /**
   * Add an account to the login queue
   */
  enqueue(accountId: number, options: { headless?: boolean } = {}): void {
    // Avoid duplicates
    if (this.hasPendingOrActive(accountId)) {
      return;
    }
    this.queue.push({ accountId, retries: 0, headless: options.headless, generation: this.clearGeneration });
    const log = addAuthLog({
      type: "queue_added",
      accountId,
      message: `Account #${accountId} queued for login`,
    });
    broadcast({ type: "queue_added", data: log });
    this.process();
  }

  /**
   * Add multiple accounts to the queue
   */
  enqueueBulk(accountIds: number[], options: { headless?: boolean } = {}): void {
    for (const id of accountIds) {
      this.enqueue(id, options);
    }
  }

  /**
   * Queue all pending accounts for login
   */
  async queueAllPending(options: { headless?: boolean } = {}): Promise<number> {
    const pendingAccounts = await db
      .select()
      .from(accounts)
      .where(eq(accounts.status, "pending"));

    for (const acc of pendingAccounts) {
      this.enqueue(acc.id, options);
    }

    return pendingAccounts.length;
  }

  /**
   * Bulk add accounts: creates DB entries for each provider, then queues login.
   * Input: array of { email, password, providers }
   * This handles the case where one email is used across multiple providers.
   */
  async bulkAdd(items: BulkAddItem[], options: { headless?: boolean; concurrency?: number } = {}): Promise<{ created: number; queued: number }> {
    let created = 0;
    const accountIds: number[] = [];

    for (const item of items) {
      for (const provider of item.providers) {
        if (!["kiro", "kiro-pro", "codebuddy", "canva", "zai", "windsurf", "moclaw"].includes(provider)) continue;

        try {
          const [newAccount] = await db
            .insert(accounts)
            .values({
              provider,
              email: item.email,
              password: encrypt(item.password),
              status: "pending",
            })
            .onConflictDoNothing()
            .returning();

          if (newAccount) {
            created++;
            accountIds.push(newAccount.id);
          }
        } catch {
          // Skip duplicates
        }
      }
    }

    if (options.concurrency !== undefined) this.setConcurrency(options.concurrency);

    // Queue all created accounts for login
    this.enqueueBulk(accountIds, { headless: options.headless });

    return { created, queued: accountIds.length };
  }

  /**
   * Bulk add with ALL providers (kiro + codebuddy + canva) for each email
   */
  async bulkAddAllProviders(
    credentials: Array<{ email: string; password: string }>
  ): Promise<{ created: number; queued: number }> {
    const items: BulkAddItem[] = credentials.map((c) => ({
      ...c,
      providers: ["kiro", "kiro-pro", "codebuddy", "canva", "zai", "windsurf", "moclaw"],
    }));
    return this.bulkAdd(items);
  }

  /**
   * Get queue status
   */
  getStatus() {
    return {
      queued: this.queue.length,
      active: this.activeJobs,
      processing: this.processing,
      totalProcessed: this.totalProcessed,
      totalSuccess: this.totalSuccess,
      totalFailed: this.totalFailed,
      retrying: this.retryTimers.size,
    };
  }

  /**
   * Clear the queue
   */
  clear(): void {
    this.queue = [];
    this.clearGeneration++;
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    if (this.activeJobs === 0) this.processing = false;
    broadcast({ type: "queue_cleared", data: {} });
  }

  /**
   * Set concurrency level
   */
  setConcurrency(n: number): void {
    this.concurrency = Math.max(1, Math.min(n, 10));
  }

  private async process(): Promise<void> {
    if (this.processing && this.activeJobs >= this.concurrency) return;
    this.processing = true;

    while (this.queue.length > 0 && this.activeJobs < this.concurrency) {
      const item = this.queue.shift();
      if (!item) break;

      this.activeJobs++;
      this.activeAccountIds.add(item.accountId);
      this.processItem(item).finally(() => {
        this.activeJobs--;
        this.activeAccountIds.delete(item.accountId);
        this.totalProcessed++;
        // Continue processing
        if (this.queue.length > 0) {
          this.process();
        } else if (this.activeJobs === 0 && this.retryTimers.size === 0) {
          this.processing = false;
          broadcast({
            type: "queue_complete",
            data: {
              totalProcessed: this.totalProcessed,
              totalSuccess: this.totalSuccess,
              totalFailed: this.totalFailed,
            },
          });
        }
      });
    }
  }

  private hasPendingOrActive(accountId: number): boolean {
    return this.queue.some((item) => item.accountId === accountId)
      || this.activeAccountIds.has(accountId)
      || this.retryTimers.has(accountId);
  }

  private async processItem(item: QueueItem): Promise<void> {
    const [account] = await db
      .select()
      .from(accounts)
      .where(eq(accounts.id, item.accountId));

    if (!account) return;

    const processingLog = addAuthLog({
      type: "queue_processing",
      accountId: item.accountId,
      email: account.email,
      provider: account.provider,
      step: `attempt_${item.retries + 1}`,
      message: `Processing ${account.provider} login for ${account.email} (attempt ${item.retries + 1})`,
      data: { remaining: this.queue.length },
    });
    broadcast({
      type: "queue_processing",
      data: {
        ...processingLog,
        accountId: item.accountId,
        email: account.email,
        provider: account.provider,
        attempt: item.retries + 1,
        remaining: this.queue.length,
      },
    });

    const result = await loginAccount(account, { headless: item.headless });

    if (result.success) {
      this.totalSuccess++;
    } else {
      if (item.retries < this.maxRetries) {
        // Re-queue with incremented retry count and delay
        if (item.generation !== this.clearGeneration) return;
        const retryGeneration = item.generation;
        const timer = setTimeout(() => {
          this.retryTimers.delete(item.accountId);
          if (retryGeneration !== this.clearGeneration) return;
          if (this.queue.some((queued) => queued.accountId === item.accountId) || this.activeAccountIds.has(item.accountId)) {
            if (this.activeJobs === 0 && this.queue.length === 0 && this.retryTimers.size === 0) this.processing = false;
            this.process();
            return;
          }
          this.queue.push({ accountId: item.accountId, retries: item.retries + 1, headless: item.headless, generation: retryGeneration });
          this.process();
        }, Math.min(2000 * Math.pow(2, item.retries), 15000)); // exponential backoff
        if (retryGeneration === this.clearGeneration) this.retryTimers.set(item.accountId, timer);
      } else {
        this.totalFailed++;
      }
    }
  }
}

export const loginQueue = new LoginQueue();
