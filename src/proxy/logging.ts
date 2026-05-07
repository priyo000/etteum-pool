import { config } from "../config";

export interface TruncatedLogBody {
  truncated: true;
  originalBytes: number;
  maxBytes: number;
  preview: string;
}

export interface UnserializableLogBody {
  unserializable: true;
  reason: string;
  preview: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function prepareLogBody(value: unknown): unknown {
  const { logBodyEnabled, logBodyFull, logBodyMaxBytes } = config;
  if (!logBodyEnabled) return null;
  if (logBodyFull) return value;

  const maxBytes = Math.max(0, logBodyMaxBytes);
  const serialized = serializeForLog(value);
  const bytes = encoder.encode(serialized).byteLength;

  if (bytes <= maxBytes) return value;

  return {
    truncated: true,
    originalBytes: bytes,
    maxBytes,
    preview: truncateUtf8(serialized, maxBytes),
  } satisfies TruncatedLogBody;
}

function serializeForLog(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return JSON.stringify({
      unserializable: true,
      reason,
      preview: String(value),
    } satisfies UnserializableLogBody);
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const bytes = encoder.encode(value);
  if (bytes.byteLength <= maxBytes) return value;
  return decoder.decode(bytes.slice(0, maxBytes));
}
