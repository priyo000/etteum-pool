import type { BaseProvider, ModelInfo } from "./base";
import { KiroProvider } from "./kiro";
import { CodeBuddyProvider } from "./codebuddy";
import { CodeBuddyChinaProvider } from "./codebuddy-china";
import { CanvaProvider } from "./canva";
import { CodexProvider } from "./codex";
import { QoderProvider } from "./qoder";
import { ByokProvider } from "./byok";
import { GitlabDuoProvider } from "./gitlab-duo";
import { YouMindProvider } from "./youmind";
import { GumloopProvider } from "./gumloop";

/**
 * Single source of truth for the provider set.
 *
 * To add / remove / change a provider you touch exactly two things:
 *   1. that provider's own file (its models + ownsModel() pattern), and
 *   2. one line in PROVIDER_ORDER below.
 *
 * Routing (getProviderForModel) and model listing (getAllModels) iterate this
 * list — there is no per-provider logic anywhere else. Order matters only for
 * disambiguating overlapping patterns: more specific providers come first, and
 * the single isFallback provider (kiro standard) is consulted last.
 */
// kiro and kiro-pro are two variants of the SAME provider class — same upstream
// (AWS CodeWhisperer), different model catalog + account pool. They keep
// distinct provider names so DB/bot/dashboard treat them separately.
const kiro = new KiroProvider({ variant: "standard" });
const kiroPro = new KiroProvider({ variant: "pro" });
const codebuddy = new CodeBuddyProvider();
const codebuddyChina = new CodeBuddyChinaProvider();
const canva = new CanvaProvider();
const codex = new CodexProvider();
const qoder = new QoderProvider();
const byok = new ByokProvider();
const gitlabDuo = new GitlabDuoProvider();
const youmind = new YouMindProvider();
const gumloop = new GumloopProvider();

// Priority order. canva/qoder/codex/kiro-pro have unique prefixes; codex
// is listed before codebuddy so the literal "gpt-5-codex" resolves to codex
// while codebuddy keeps its own "gpt-5*"/"gpt-5.x-codex" models. byok checks
// dynamic prefixes from DB accounts. kiro is the fallback.
const PROVIDER_ORDER = [canva, qoder, codex, kiroPro, byok, codebuddyChina, codebuddy, kiro] as const;

export const providers = {
  kiro,
  "kiro-pro": kiroPro,
  codebuddy,
  "codebuddy-china": codebuddyChina,
  canva,
  codex,
  qoder,
  byok,
  "gitlab-duo": gitlabDuo,
  youmind,
  gumloop,
} as const;

export type ProviderName = keyof typeof providers;

/** Map a model id to the provider that handles it. */
export function getProviderForModel(model: string): ProviderName | null {
  for (const provider of PROVIDER_ORDER) {
    if (provider.ownsModel(model)) return provider.name as ProviderName;
  }
  const fallback = PROVIDER_ORDER.find((p) => p.isFallback);
  return (fallback?.name as ProviderName) ?? null;
}

/** All models across every registered provider. */
export function getAllModels(): ModelInfo[] {
  return PROVIDER_ORDER.flatMap((provider) => provider.getModels());
}

/** Iterable list of provider instances (priority order). */
export const providerList: readonly BaseProvider[] = PROVIDER_ORDER;

/** Refresh BYOK models from database. */
export async function refreshByokModels(): Promise<void> {
  await byok.refreshModelsCache();
}

/** Refresh GitLab Duo models from every active gitlab-duo account's metadata. */
export async function refreshGitlabDuoModels(): Promise<void> {
  await gitlabDuo.refreshModelsCache();
}

/** Get BYOK provider instance. */
export function getByokProvider(): ByokProvider {
  return byok;
}
