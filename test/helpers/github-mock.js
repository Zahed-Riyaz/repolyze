// A fake GitHub for tests: routes API paths (repo prefix stripped) to JSON,
// serves raw.githubusercontent.com files, and records every request.
//
//   const gh = githubMock({ "/issues": [...], "/languages": {...} }, { raw: { "README.md": "# Hi" } });
//   loadPanel({ fetch: gh.fetch });
//   gh.apiCalls  → ["/issues?state=open…", …]   (only calls that cost API quota)
//
// A route value may be data (→ 200 JSON), a Response, or a function (url, init) → Response.
// Lookup tries the exact path+query first, then the path alone. Unknown → 404.

const RATE_HEADERS = { "X-RateLimit-Remaining": "4999", "X-RateLimit-Limit": "5000", "X-RateLimit-Reset": "9999999999" };

function json(body, { status = 200, headers = {} } = {}) {
  return new Response(body === null ? null : JSON.stringify(body), { status, headers: { ...RATE_HEADERS, ...headers } });
}

function githubMock(routes = {}, { raw = {}, repoPrefix = "/repos/o/r", ai } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ url, init });
    if (u.host === "raw.githubusercontent.com") {
      const filePath = decodeURIComponent(u.pathname.split("/").slice(4).join("/"));
      return filePath in raw ? new Response(raw[filePath]) : new Response("404: Not Found", { status: 404 });
    }
    if (ai && /groq|openai|anthropic|googleapis|localhost:11434/.test(u.host)) return ai(url, init);
    if (u.host !== "api.github.com") throw new Error(`unexpected fetch to ${url}`);

    let p = u.pathname.startsWith(repoPrefix) ? u.pathname.slice(repoPrefix.length) : u.pathname;
    const keys = [p + u.search, p, p === "" ? "" : null].filter(k => k !== null);
    for (const k of keys) {
      if (k in routes) {
        const route = routes[k];
        if (typeof route === "function") return route(url, init);
        return route instanceof Response ? route.clone() : json(route);
      }
    }
    return json({ message: "Not Found" }, { status: 404 });
  };
  return {
    fetch,
    calls,
    get apiCalls() {
      return calls.filter(c => c.url.startsWith("https://api.github.com/"))
        .map(c => c.url.replace("https://api.github.com" + repoPrefix, "").replace("https://api.github.com", ""));
    },
    get rawCalls() { return calls.filter(c => c.url.startsWith("https://raw.githubusercontent.com/")).map(c => c.url); },
  };
}

// An OpenAI-compatible SSE stream (Groq/OpenAI) that replies with `text`
function sseReply(text) {
  const chunks = text.match(/[\s\S]{1,16}/g) || [""];
  const body = chunks.map(t => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body);
}

module.exports = { githubMock, json, sseReply, RATE_HEADERS };
