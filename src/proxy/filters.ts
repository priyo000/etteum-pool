/**
 * Content filter system for removing patterns that trigger content moderation.
 * Based on enowxai's pudidil filter template system.
 *
 * Rules are ordered: broad regex patterns first, then exact string fallbacks.
 */

export interface FilterRule {
  id: string;
  pattern: string;
  replacement: string;
  is_active: boolean;
  is_regex: boolean;
}

export const PUDIDIL_FILTERS: FilterRule[] = [
  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 1: Broad regex rules FIRST — catch all variations before exact
  //          strings can partially match and leave fragments behind.
  // ═══════════════════════════════════════════════════════════════════════════

  // Catch full billing header lines (any version, any entrypoint)
  {
    id: "remove_billing_header_regex",
    pattern: "x-(?:anthropic-)?billing-header:?\\s*[^\\n]*",
    replacement: "",
    is_active: true,
    is_regex: true,
  },
  // Catch any cc_entrypoint variation (cli, gui, vscode, jetbrains, etc.)
  {
    id: "remove_cc_entrypoint_any",
    pattern: "cc_entrypoint=\\w+",
    replacement: "",
    is_active: true,
    is_regex: true,
  },
  // Catch cc_version=X.Y.Z patterns (any version)
  {
    id: "remove_cc_version_any",
    pattern: "cc_version=[\\w.]+",
    replacement: "",
    is_active: true,
    is_regex: true,
  },
  // Catch cch= and ch= hash patterns
  {
    id: "remove_cch_hash",
    pattern: "c?ch=[a-f0-9]+",
    replacement: "",
    is_active: true,
    is_regex: true,
  },
  // Remove claude-code GitHub references (full URL with path)
  {
    id: "remove_claude_code_github",
    pattern: "https?://github\\.com/anthropics/claude-code[^\\s]*",
    replacement: "",
    is_active: true,
    is_regex: true,
  },
  // Remove Claude Code identity variations (case-insensitive)
  {
    id: "remove_claude_code_identity_variations",
    pattern: "You are Claude Code[^.]*\\.",
    replacement: "",
    is_active: true,
    is_regex: true,
  },
  // Remove Anthropic CLI references
  {
    id: "remove_anthropic_cli_ref",
    pattern: "Anthropic'?s official (?:CLI|tool|agent)[^.]*\\.?",
    replacement: "",
    is_active: true,
    is_regex: true,
  },
  // Remove "Anxthxropic" obfuscated references
  {
    id: "remove_anxthxropic_ref",
    pattern: "Anxthxropic'?s official[^.]*\\.?",
    replacement: "",
    is_active: true,
    is_regex: true,
  },
  // Remove Cursor agent identity
  {
    id: "remove_cursor_identity",
    pattern: "You are (?:a )?(?:powerful )?(?:AI )?(?:assistant|agent) (?:made|built|created) by (?:Cursor|Anysphere)[^.]*\\.?",
    replacement: "",
    is_active: true,
    is_regex: true,
  },
  // Remove Windsurf/Codeium agent identity
  {
    id: "remove_windsurf_identity",
    pattern: "You are (?:Windsurf|Cascade|Codeium)[^.]*\\.",
    replacement: "",
    is_active: true,
    is_regex: true,
  },
  // Remove Cline agent identity
  {
    id: "remove_cline_identity",
    pattern: "You are Cline[^.]*\\.",
    replacement: "",
    is_active: true,
    is_regex: true,
  },
  // Remove generic "AI coding agent" patterns that may trigger moderation
  {
    id: "remove_ai_coding_agent_pattern",
    pattern: "(?:autonomous|agentic) (?:AI |coding )?(?:agent|assistant)[^.]*\\.",
    replacement: "",
    is_active: true,
    is_regex: true,
  },
  // Remove tool use framework identifiers (MCP, tool_use markers)
  {
    id: "remove_mcp_server_ref",
    pattern: "MCP (?:server|client|protocol)[^.]*\\.?",
    replacement: "",
    is_active: true,
    is_regex: true,
  },
  // Remove "powered by Claude" / "powered by Anthropic" patterns
  {
    id: "remove_powered_by_anthropic",
    pattern: "powered by (?:Claude|Anthropic|Anxthxropic)[^.]*\\.?",
    replacement: "",
    is_active: true,
    is_regex: true,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 2: Exact string rules — catch any remaining known literal patterns
  //          that survived the regex phase.
  // ═══════════════════════════════════════════════════════════════════════════

  {
    id: "remove_feedback_line",
    pattern: "Claude Code. To give feedback, users should report the issue at https://github.com/anthropics/claude-code/issues",
    replacement: "",
    is_active: true,
    is_regex: false,
  },
  {
    id: "remove_powerful_ai_agent",
    pattern: "Advanced AI Agent",
    replacement: "",
    is_active: true,
    is_regex: false,
  },
  {
    id: "remove_claude_code_identity",
    pattern: "You are Claude Code, Anxthxropic's official CLI for Claude.",
    replacement: "",
    is_active: true,
    is_regex: false,
  },
  // Replace remaining "Claude Code" mentions with neutral text
  {
    id: "remove_claude_code_mention",
    pattern: "Claude Code",
    replacement: "the assistant",
    is_active: true,
    is_regex: false,
  },
];

import { getFilterRulesCached } from "./filter-cache";

/**
 * Apply pudidil filters to a string. Reads rules from in-memory cache (DB-backed).
 * Falls back to PUDIDIL_FILTERS const if cache is empty (pre-boot).
 */
export function applyPudidilFilters(content: string): string {
  let filtered = content;
  const cached = getFilterRulesCached();
  const rules = cached.length > 0
    ? cached.map((r) => ({ pattern: r.pattern, replacement: r.replacement, is_active: r.isActive, is_regex: r.isRegex }))
    : PUDIDIL_FILTERS;

  for (const rule of rules) {
    if (!rule.is_active) continue;

    if (rule.is_regex) {
      try {
        const regex = new RegExp(rule.pattern, "gi");
        filtered = filtered.replace(regex, rule.replacement);
      } catch (error) {
        console.error(`[Filter] Invalid regex pattern: ${rule.pattern}`, error);
      }
    } else {
      if (!rule.pattern) continue;
      while (filtered.includes(rule.pattern)) {
        filtered = filtered.replace(rule.pattern, rule.replacement);
      }
    }
  }

  return filtered;
}
