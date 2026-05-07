/**
 * Content filter system for removing patterns that trigger content moderation
 * Based on enowxai's pudidil filter template system
 */

export interface FilterRule {
  id: string;
  pattern: string;
  replacement: string;
  is_active: boolean;
  is_regex: boolean;
}

export interface FilterTemplate {
  name: string;
  rules: FilterRule[];
}

/**
 * Pudidil filter template - removes Claude Code CLI detection patterns
 * Based on enowxai's filter system
 */
/**
 * Filter rules — exact match with enowxai's pudidil template.
 * Order and patterns must match the screenshot/config exactly.
 */
export const PUDIDIL_FILTERS: FilterRule[] = [
  {
    id: "remove_cc_entrypoint",
    pattern: "cc_entrypoint=cli",
    replacement: "",
    is_active: true,
    is_regex: false,
  },
  {
    id: "remove_billing_header_full",
    pattern: "x-billing-header: cc_version=2.114.45a; cc_entrypoint=cli; ch=33c97;",
    replacement: "",
    is_active: true,
    is_regex: false,
  },
  {
    id: "remove_billing_header_key",
    pattern: "x-billing-header",
    replacement: "",
    is_active: true,
    is_regex: false,
  },
  {
    id: "remove_feedback_line",
    pattern: "Claude Code. To give feedback, users should report the issue at https://github.com/anthropics/claude-code/issues",
    replacement: "",
    is_active: true,
    is_regex: false,
  },
  {
    id: "remove_github_issues_link",
    pattern: "https://github.com/anthropics/claude-code/issues",
    replacement: "",
    is_active: true,
    is_regex: false,
  },
  {
    id: "remove_powerful_ai_agent",
    pattern: "Powerful AI Agent",
    replacement: "",
    is_active: true,
    is_regex: false,
  },
  {
    id: "remove_anthropic_billing_header_key",
    pattern: "x-anthropic-billing-header",
    replacement: "",
    is_active: true,
    is_regex: false,
  },
  {
    id: "remove_anthropic_billing_header_full",
    pattern: "x-anthropic-billing-header: cc_version=2.1.116.f49; cc_entrypoint=cli; cch=8b6e8",
    replacement: "",
    is_active: true,
    is_regex: false,
  },
  {
    id: "remove_claude_code_identity",
    pattern: "You are Claude Code, Anthropic's official CLI for Claude.",
    replacement: "",
    is_active: true,
    is_regex: false,
  },
  // Catch newer cc_version patterns that may appear in future updates
  {
    id: "remove_billing_header_regex",
    pattern: "x-(?:anthropic-)?billing-header:?\\s*cc_version=[^\\n]+",
    replacement: "",
    is_active: true,
    is_regex: true,
  },
];

/**
 * Apply pudidil filters to a string
 */
export function applyPudidilFilters(content: string): string {
  let filtered = content;

  for (const rule of PUDIDIL_FILTERS) {
    if (!rule.is_active) continue;

    if (rule.is_regex) {
      try {
        const regex = new RegExp(rule.pattern, "gi");
        filtered = filtered.replace(regex, rule.replacement);
      } catch (error) {
        console.error(`[Filter] Invalid regex pattern: ${rule.pattern}`, error);
      }
    } else {
      // Simple string replacement (case-sensitive for exact matches)
      // Skip empty patterns to avoid infinite loops
      if (!rule.pattern) continue;
      // Use global replace to remove all occurrences
      while (filtered.includes(rule.pattern)) {
        filtered = filtered.replace(rule.pattern, rule.replacement);
      }
    }
  }

  return filtered;
}
