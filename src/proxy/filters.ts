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
export const PUDIDIL_FILTERS: FilterRule[] = [
  // Remove entire Claude Code system prompt block (most aggressive)
  {
    id: "remove_claude_code_system_block",
    pattern: "You are Claude Code, Anthropic's official CLI for Claude\\.\\s*You are an interactive agent that helps users with software engineering tasks\\.[\\s\\S]*?# Environment",
    replacement: "",
    is_active: true,
    is_regex: true,
  },
  // Remove billing headers
  {
    id: "remove_billing_header_regex",
    pattern: "x-billing-header:\\s*cc_version=[^;]+;\\s*cc_entrypoint=cli;\\s*ch=[^;\\s]+;?",
    replacement: "",
    is_active: true,
    is_regex: true,
  },
  {
    id: "remove_anthropic_billing_header_regex",
    pattern: "x-anthropic-billing-header:\\s*cc_version=[^;]+;\\s*cc_entrypoint=cli;\\s*cch=[^;\\s]+;?",
    replacement: "",
    is_active: true,
    is_regex: true,
  },
  {
    id: "remove_anthropic_billing_header_fallback",
    pattern: "x-anthropic-billing-header",
    replacement: "",
    is_active: true,
    is_regex: false,
  },
  // Remove Claude Code identity sections
  {
    id: "remove_claude_code_full_identity",
    pattern: "You are Claude Code, Anthropic's official CLI for Claude\\.\\s*You are an interactive agent that helps users with software engineering tasks\\. Use the instructions below and the tools available to you to assist the user\\.",
    replacement: "",
    is_active: true,
    is_regex: true,
  },
  {
    id: "remove_claude_code_identity",
    pattern: "You are Claude Code, Anthropic's official CLI for Claude.",
    replacement: "",
    is_active: true,
    is_regex: false,
  },
  {
    id: "remove_interactive_agent_instruction",
    pattern: "You are an interactive agent that helps users with software engineering tasks. Use the instructions below and the tools available to you to assist the user.",
    replacement: "",
    is_active: true,
    is_regex: false,
  },
  // Remove specific instruction blocks
  {
    id: "remove_security_testing_block",
    pattern: "IMPORTANT: Assist with authorized security testing[\\s\\S]*?IMPORTANT: You must NEVER generate or guess URLs[^.]+\\.",
    replacement: "",
    is_active: true,
    is_regex: true,
  },
  {
    id: "remove_system_section",
    pattern: "# System\\s*- All text you output[\\s\\S]*?# Doing tasks",
    replacement: "# Doing tasks",
    is_active: true,
    is_regex: true,
  },
  {
    id: "remove_auto_memory_section",
    pattern: "# auto memory\\s*You have a persistent[\\s\\S]*?# Environment",
    replacement: "# Environment",
    is_active: true,
    is_regex: true,
  },
  // Remove feedback and links
  {
    id: "remove_claude_code_feedback",
    pattern: "To give feedback, users should report the issue at https://github.com/anthropics/claude-code/issues",
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
  // Generic patterns last
  {
    id: "remove_cli_entrypoint",
    pattern: "cc_entrypoint=cli",
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
      // Use global replace to remove all occurrences
      while (filtered.includes(rule.pattern)) {
        filtered = filtered.replace(rule.pattern, rule.replacement);
      }
    }
  }

  return filtered;
}
