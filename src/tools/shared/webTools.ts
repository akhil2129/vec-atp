/**
 * Web search and web read tools for VEC agents.
 *
 * web_search — Query SearXNG (local meta-search engine) and return results.
 * web_read   — Fetch a URL and return its text content (HTML stripped).
 *
 * Requires SearXNG running locally (docker run -d -p 8888:8080 searxng/searxng).
 * Configure via SEARXNG_URL env var (default: http://localhost:8888).
 */

import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { config } from "../../config.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function ok(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

/** Strip HTML tags and decode common entities. Good enough for LLM consumption. */
function stripHtml(html: string): string {
  return html
    // Remove script/style blocks entirely
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    // Replace block-level tags with newlines
    .replace(/<\/(p|div|h[1-6]|li|tr|br|hr|blockquote|pre|section|article|header|footer|nav|main)[\s>]/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    // Strip remaining tags
    .replace(/<[^>]+>/g, "")
    // Decode common entities
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    // Collapse whitespace
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

interface SearxResult {
  title?: string;
  url?: string;
  content?: string; // snippet
}

// ── Tools ────────────────────────────────────────────────────────────────────

export function getWebTools(): AgentTool[] {
  const web_search: AgentTool = {
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web using SearXNG. Returns a list of results with titles, URLs, and snippets. " +
      "Use this to find current information, documentation, tutorials, or any web-based knowledge.",
    parameters: Type.Object({
      query: Type.String({ description: "The search query" }),
      num_results: Type.Optional(Type.Number({ description: "Max results to return (default 10, max 20)" })),
    }),
    execute: async (_, params: any) => {
      const query = (params.query ?? "").trim();
      if (!query) return ok("Error: empty search query.");

      const limit = Math.min(Math.max(params.num_results ?? 10, 1), 20);
      const url = `${config.searxngUrl}/search?q=${encodeURIComponent(query)}&format=json&categories=general&pageno=1`;

      try {
        const res = await fetch(url, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(15_000),
        });

        if (!res.ok) {
          return ok(`SearXNG error: HTTP ${res.status} ${res.statusText}. Is SearXNG running at ${config.searxngUrl}?`);
        }

        const data = (await res.json()) as { results?: SearxResult[] };
        const results = (data.results ?? []).slice(0, limit);

        if (!results.length) return ok(`No results found for: "${query}"`);

        const formatted = results
          .map((r, i) => {
            const title = r.title ?? "(no title)";
            const snippet = r.content ?? "";
            return `${i + 1}. **${title}**\n   URL: ${r.url}\n   ${snippet}`;
          })
          .join("\n\n");

        return ok(`Search results for "${query}" (${results.length} results):\n\n${formatted}`);
      } catch (err: any) {
        if (err?.name === "TimeoutError" || err?.name === "AbortError") {
          return ok(`Search timed out. Is SearXNG running at ${config.searxngUrl}?`);
        }
        return ok(`Search failed: ${err?.message ?? err}. Is SearXNG running at ${config.searxngUrl}?`);
      }
    },
  };

  const web_read: AgentTool = {
    name: "web_read",
    label: "Read Web Page",
    description:
      "Fetch a web page URL and return its text content (HTML stripped). " +
      "Use this to read articles, documentation pages, or any public web page. " +
      "Pair with web_search to first find URLs, then read their content.",
    parameters: Type.Object({
      url: Type.String({ description: "The full URL to fetch (must start with http:// or https://)" }),
      max_length: Type.Optional(Type.Number({ description: "Max characters to return (default 8000, max 30000)" })),
    }),
    execute: async (_, params: any) => {
      const url = (params.url ?? "").trim();
      if (!url) return ok("Error: empty URL.");
      if (!/^https?:\/\//i.test(url)) return ok("Error: URL must start with http:// or https://");

      const maxLen = Math.min(Math.max(params.max_length ?? 8000, 500), 30000);

      try {
        const res = await fetch(url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; VEC-Agent/1.0)",
            Accept: "text/html,application/xhtml+xml,text/plain,application/json,*/*",
          },
          redirect: "follow",
          signal: AbortSignal.timeout(20_000),
        });

        if (!res.ok) {
          return ok(`HTTP error: ${res.status} ${res.statusText} for ${url}`);
        }

        const contentType = res.headers.get("content-type") ?? "";
        const raw = await res.text();

        let text: string;
        if (contentType.includes("text/html") || contentType.includes("xhtml")) {
          text = stripHtml(raw);
        } else {
          // Plain text, JSON, etc. — return as-is
          text = raw;
        }

        if (text.length > maxLen) {
          text = text.substring(0, maxLen) + `\n\n--- Truncated at ${maxLen} characters ---`;
        }

        return ok(`Content from ${url}:\n\n${text}`);
      } catch (err: any) {
        if (err?.name === "TimeoutError" || err?.name === "AbortError") {
          return ok(`Request timed out after 20s for ${url}`);
        }
        return ok(`Failed to fetch ${url}: ${err?.message ?? err}`);
      }
    },
  };

  return [web_search, web_read];
}
