const LIMIT = 240;

// This projection is deliberately lossy: it preserves a causal host/path/error
// term while replacing values that can identify a user, session, or secret.
export function sanitizeTelemetryText(value, { limit = LIMIT } = {}) {
  if (value == null || value === "") return null;
  let text = String(value).replace(/[\r\n\t]+/g, " ").trim();
  text = stripUrlCredentialsAndQuery(text);
  text = text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED_TOKEN]")
    .replace(/\b(?:x[._ -]?api[._ -]?key|api[._ -]?key|access[._-]?token|token|secret|password)\b\s*(?:[=:]|\s+)\s*[^\s,;]+/gi, "secret=[REDACTED_SECRET]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_JWT]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED_EMAIL]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[REDACTED_ID]")
    .replace(/\b(session(?:[._-]?id|id)?|user(?:[._-]?id|id)?|account(?:[._-]?id|id)?)\s*(?:[=:]|\s+)\s*[^\s,;]+/gi, (_match, key) => `${key}=[REDACTED_ID]`)
    .replace(/\b\d{8,}\b/g, "[REDACTED_ID]");
  return text.slice(0, limit);
}

function stripUrlCredentialsAndQuery(text) {
  return text.replace(/\b(?:https?|grpc):\/\/[^\s"']+/gi, (raw) => {
    try {
      const url = new URL(raw);
      return `${url.protocol}//${url.host}${sanitizePath(url.pathname)}`;
    } catch {
      return raw.replace(/\/\/[^/@\s]+@/, "//").replace(/[?#][^\s"']*/, "");
    }
  }).replace(/\b([A-Za-z0-9.-]+:\d+)(?:[?#][^\s,;]*)/g, "$1");
}

function sanitizePath(pathname) {
  return pathname.split("/").map((segment) => {
    if (/^[0-9a-f]{8}-[0-9a-f-]{16,}$/i.test(segment) || /^\d{8,}$/.test(segment)) return "[REDACTED_ID]";
    return segment;
  }).join("/");
}
