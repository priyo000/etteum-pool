import { db } from "../db/index";
import { filterRules, type FilterRule } from "../db/schema";
import { asc } from "drizzle-orm";

let cache: FilterRule[] = [];

export async function loadFilterCache(): Promise<void> {
  cache = await db.select().from(filterRules).orderBy(asc(filterRules.sortOrder));
}

export function getFilterRulesCached(): FilterRule[] {
  return cache;
}

export function invalidateFilterCache(): void {
  loadFilterCache().catch((e) => console.error("[FilterCache] reload failed", e));
}
