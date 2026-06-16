/** Canva brand plan codes seen on the brandPlanDescription field. */
export type CanvaPlanCode = "A" | "L" | "P" | "E" | string;

export interface PlanInfo {
  code: CanvaPlanCode;
  label: string;
  tier: "free" | "team" | "pro" | "enterprise" | "unknown";
  rank: number;
  color: "gray" | "yellow" | "green" | "blue" | "purple";
  description: string;
}

const PLAN_TABLE: Record<string, PlanInfo> = {
  A: {
    code: "A",
    label: "Free",
    tier: "free",
    rank: 1,
    color: "gray",
    description: "Free personal — 100 AI credits/month, basic features",
  },
  L: {
    code: "L",
    label: "Limited (free team)",
    tier: "team",
    rank: 2,
    color: "yellow",
    description: "Limited team — same free quota, shared brand kit",
  },
  P: {
    code: "P",
    label: "Pro",
    tier: "pro",
    rank: 4,
    color: "green",
    description: "Canva Pro — 500+ AI credits/month, premium features",
  },
  E: {
    code: "E",
    label: "Enterprise",
    tier: "enterprise",
    rank: 5,
    color: "blue",
    description: "Enterprise — pooled quota, advanced controls",
  },
};

/** Decode a Canva plan code into normalized info. Unknown codes return tier='unknown', rank=0. */
export function decodePlan(code: string | null | undefined): PlanInfo {
  if (code == null || code === "") {
    return {
      code: "",
      label: "Unknown",
      tier: "unknown",
      rank: 0,
      color: "purple",
      description: "Unknown plan code — please report",
    };
  }
  const known = PLAN_TABLE[code];
  if (known) return known;
  return {
    code,
    label: `Plan ?${code}`,
    tier: "unknown",
    rank: 0,
    color: "purple",
    description: "Unknown plan code — please report",
  };
}

/** Sort brands by plan rank desc (best first). Personal brand always last regardless of rank. */
export function sortBrandsByPlan<T extends { plan?: string; personal?: boolean }>(brands: T[]): T[] {
  return [...brands].sort((a, b) => {
    const aPersonal = a.personal === true;
    const bPersonal = b.personal === true;
    if (aPersonal !== bPersonal) return aPersonal ? 1 : -1;
    const aRank = decodePlan(a.plan).rank;
    const bRank = decodePlan(b.plan).rank;
    return bRank - aRank;
  });
}

/** Pick the brand the pool SHOULD use for max quota — highest rank, non-personal, non-archived. Falls back to personal if nothing else. */
export function pickBestBrand<T extends { id: string; plan?: string; personal?: boolean; archived?: boolean }>(
  brands: T[],
): T | null {
  if (brands.length === 0) return null;

  const eligible = brands.filter((b) => b.personal !== true && b.archived !== true);
  if (eligible.length > 0) {
    let best = eligible[0]!;
    let bestRank = decodePlan(best.plan).rank;
    for (let i = 1; i < eligible.length; i++) {
      const candidate = eligible[i]!;
      const candidateRank = decodePlan(candidate.plan).rank;
      if (candidateRank > bestRank) {
        best = candidate;
        bestRank = candidateRank;
      }
    }
    return best;
  }

  const nonArchived = brands.filter((b) => b.archived !== true);
  if (nonArchived.length > 0) return nonArchived[0]!;
  return brands[0]!;
}
