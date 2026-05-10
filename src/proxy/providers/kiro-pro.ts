import { KiroProvider } from "./kiro";
import type { ModelInfo, ChatCompletionRequest } from "./base";
import type { Account } from "../../db/schema";

/** Map kp- prefixed model IDs to actual Kiro API model names */
const kpModelMap: Record<string, string> = {
  "kp-auto": "auto",
  "kp-sonnet-4.6": "claude-sonnet-4.6",
  "kp-haiku-4.5": "claude-haiku-4.5",
};

/**
 * Kiro Pro Provider — same as Kiro but with Pro-exclusive models (Opus).
 * Uses separate account pool for Pro/Pro+/Power tier accounts.
 */
export class KiroProProvider extends KiroProvider {
  override name = "kiro-pro";

  override supportedModels: ModelInfo[] = [
    { id: "kp-auto", object: "model", created: Date.now(), owned_by: "kiro-pro", tier: "standard", context_window: 1000000, max_output: 64000, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.018 / 1000, creditSource: "estimated" },
    { id: "claude-opus-4.7", object: "model", created: Date.now(), owned_by: "kiro-pro", tier: "standard", context_window: 1000000, max_output: 64000, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.018 / 1000, creditSource: "estimated" },
    { id: "claude-opus-4.6", object: "model", created: Date.now(), owned_by: "kiro-pro", tier: "standard", context_window: 1000000, max_output: 64000, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.018 / 1000, creditSource: "estimated" },
    { id: "claude-opus-4.5", object: "model", created: Date.now(), owned_by: "kiro-pro", tier: "standard", context_window: 200000, max_output: 64000, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.018 / 1000, creditSource: "estimated" },
    { id: "kp-sonnet-4.6", object: "model", created: Date.now(), owned_by: "kiro-pro", tier: "standard", context_window: 1000000, max_output: 64000, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.012 / 1000, creditSource: "estimated" },
    { id: "kp-haiku-4.5", object: "model", created: Date.now(), owned_by: "kiro-pro", tier: "standard", context_window: 200000, max_output: 64000, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.003 / 1000, creditSource: "estimated" },
  ];

  /** Resolve kp- prefixed model to actual API model name */
  private resolveModel(model: string): string {
    return kpModelMap[model] || model;
  }

  override async chatCompletion(account: Account, request: ChatCompletionRequest) {
    return super.chatCompletion(account, { ...request, model: this.resolveModel(request.model) });
  }

  override async chatCompletionStream(account: Account, request: ChatCompletionRequest) {
    return super.chatCompletionStream(account, { ...request, model: this.resolveModel(request.model) });
  }
}
