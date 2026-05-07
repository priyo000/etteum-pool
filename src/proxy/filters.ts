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
 * Filter rules matching enowxai's approach:
 * - Simple string removal for identity/billing markers
 * - Keep system prompt structure intact (CLAUDE.md, tools, environment preserved)
 * - No aggressive regex that strips entire sections
 */
export const PUDIDIL_FILTERS: FilterRule[] = [
  // Remove Claude Code identity string
  {
    id: "remove_claude_code_identity",
    pattern: "You are Claude Code, Anxthxropic's official CLI for Claude.",
    replacement: "",
    is_active: true,
    is_regex: false,
  },
  // Remove interactive agent instruction
  {
    id: "remove_interactive_agent_instruction",
    pattern: "You are an interactive agent that helps users with software engineering tasks. Use the instructions below and the tools available to you to assist the user.",
    replacement: "",
    is_active: true,
    is_regex: false,
  },
  // Remove billing/version headers (specific versions from enowxai)
  {
    id: "remove_billing_header_1",
    pattern: ": cc_version=2.114.45a; ; ch=33c97;",
    replacement: "",
    is_active: true,
    is_regex: false,
  },
  {
    id: "remove_billing_header_2",
    pattern: ": cc_version=2.1.116.f49; ; cch=8b6e8",
    replacement: "",
    is_active: true,
    is_regex: false,
  },
  // Catch other cc_version patterns via regex
  {
    id: "remove_billing_header_regex",
    pattern: ":\\s*cc_version=[^;]+;\\s*;\\s*c?ch=[^;\\s]+;?",
    replacement: "",
    is_active: true,
    is_regex: true,
  },
  // Remove "Advanced AI Agent" marker
  {
    id: "remove_advanced_ai_agent",
    pattern: "Advanced AI Agent",
    replacement: "",
    is_active: true,
    is_regex: false,
  },
  // Remove feedback link line
  {
    id: "remove_feedback_link",
    pattern: "To give feedback, users should report the issue at ",
    replacement: "",
    is_active: true,
    is_regex: false,
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
