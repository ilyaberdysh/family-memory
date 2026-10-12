# Open-source agent runtime research

Reviewed on 13 October 2026 for the conversation-first Family Memory redesign.
This note compares projects that can own the model/tool loop so Family Memory
does not have to implement its own general-purpose agent runtime.

## Recommendation

Use **Mastra** for the first product spike. It is TypeScript-first, already
integrates with AI SDK v7, supports MCP, streaming, persistent memory, and
durable human approval. That lets Family Memory keep its current React chat,
Express authentication, PostgreSQL data, and proposal-review workflow.

Keep **OpenAI Agents SDK for TypeScript** as the smaller fallback. It has a
finished tool loop, streaming, sessions, MCP, guardrails, and resumable tool
approvals, but is most natural when OpenAI remains the primary provider.

Do not make OpenCode, Codex CLI, OpenHands, Goose, or Open WebUI the shared
multi-family trust boundary. They can be useful isolated sidecars or prototypes,
but their server/session identifiers do not replace Family Memory authentication,
`family_id`, or PostgreSQL Row-Level Security.

## Shortlist

| Project | Best use here | Strengths | Main problem |
| --- | --- | --- | --- |
| [Mastra](https://github.com/mastra-ai/mastra) | First production-shaped spike | TypeScript, AI SDK v7 streams, model-neutral agent loop, MCP, Postgres memory, suspend/resume and approval | Broad, fast-moving framework; enterprise packages have separate terms |
| [OpenAI Agents SDK JS](https://github.com/openai/openai-agents-js) | Lean alternative | Small API, sessions, handoffs, MCP, tool approvals and guardrails | Strongest path is OpenAI; tracing must be disabled or stripped for private family content |
| [LangGraph.js](https://github.com/langchain-ai/langgraphjs) | Later, for long research workflows | Durable state, checkpoints, branching, retries, interrupts that resume after days | More orchestration code and concepts than the current assistant needs |
| [OpenHands Agent SDK](https://github.com/OpenHands/software-agent-sdk) | Isolated production sidecar | Mature remote workspace/container story, typed tools, MCP, REST/WebSocket Agent Server | Python sidecar and no tenant authorization in the OSS Agent Server |
| [Goose](https://github.com/aaif-goose/goose) | Fast local “family researcher” recipe prototype | General-purpose posture, strong MCP/recipe model, many providers, Apache-2.0 | Local/single-user trust model; server is not a multi-tenant authorization boundary |
| [OpenCode](https://github.com/anomalyco/opencode) | Isolated harness experiment | Excellent TypeScript SDK, HTTP/OpenAPI/SSE, custom tools, many model providers | Coding-oriented; permissions are not a hard sandbox; no family/user isolation |
| [OpenAI Codex CLI](https://github.com/openai/codex) | Security/sandbox reference | Strong OS sandbox, approvals, MCP, app-server and SDK | Deeply coding-oriented; custom dynamic tools and production remote transport are less settled |
| [Open WebUI](https://github.com/open-webui/open-webui) | UX and research sandbox only | Complete chat product, tools, web search, RAG, memory, MCP and RBAC | A second full application with its own users/data; poor embedding fit; current license restricts rebranding |

## Why Open WebUI is not the application shell

Open WebUI has many of the visible capabilities the redesign needs: persistent
chat, web search, RAG, server-side tools, native Streamable HTTP MCP, user roles,
groups, and memory. It is useful for testing how source cards, research steps,
and tool approvals should feel.

It is not a clean library or headless agent core. Adopting it would introduce a
separate Svelte/FastAPI product with its own authentication, database, chat
storage, RAG stack, and permissions. There is no first-class embedded chat
widget. An iframe or a deep fork would make single sign-on, styling, navigation,
and privacy rules brittle. The current Open WebUI License also requires visible
branding above its stated small-deployment exception unless a commercial
license is obtained.

Sources: [tools and approvals](https://docs.openwebui.com/features/extensibility/plugin/tools/),
[server-side tool loop](https://docs.openwebui.com/reference/server-side-tool-calling/),
[MCP](https://docs.openwebui.com/features/extensibility/mcp/),
[RBAC](https://docs.openwebui.com/features/authentication-access/rbac/), and
[license](https://github.com/open-webui/open-webui/blob/main/LICENSE).

## Required architecture boundary

The application remains the owner of identity, family membership, source
provenance, and every durable fact.

```text
Browser
  -> Family Memory Express API
       -> authenticate actor and select family_id
       -> load conversation through RLS
       -> run agent with trusted server-side context
            -> read-only search/fetch tools
            -> proposal-only write tools
       -> persist messages, sources and proposals through Family Memory
```

The model never chooses its own `family_id`. Tool arguments must not contain an
authoritative tenant identifier. The server injects family and actor context
after authentication.

Initial tools should be narrow:

- `search_family_context` — read only the people and accepted facts relevant to
  this conversation;
- `search_public_sources` — search approved public indexes with explicit query
  fields and egress limits;
- `fetch_source` — retrieve one allowed result and record URL, access time, and
  a bounded excerpt or content hash;
- `propose_person`, `propose_fact`, `propose_relationship` — create reviewable
  proposals only;
- `draft_memory` — prepare an album story without publishing it.

No agent tool may accept a proposal, merge people, link an account to a person,
or confirm a fact. Those remain explicit human actions in the primary API.

## Suggested spike

1. Replace only the current `streamText` reply path with a Mastra agent behind a
   feature flag. Do not migrate the UI or canonical conversation storage.
2. Add three read-only tools: family context, public search, and source fetch.
3. Add one proposal-only tool and reuse the existing proposal review screen.
4. Run the same synthetic research task with Mastra and OpenAI Agents SDK.
5. Test cancellation, retries, token and iteration budgets, source attribution,
   prompt injection, and attempts to cross family boundaries.
6. Keep the runtime only if it improves research quality without weakening the
   existing manual and verification boundaries.

## Primary references

- Mastra: [memory](https://mastra.ai/docs/memory/overview),
  [human approval](https://mastra.ai/docs/agents/human-in-the-loop),
  [streaming](https://mastra.ai/docs/guides/streaming),
  [MCP](https://mastra.ai/docs/agents/mcp-guide)
- OpenAI Agents SDK: [overview](https://openai.github.io/openai-agents-js/),
  [sessions](https://openai.github.io/openai-agents-js/guides/sessions/),
  [human in the loop](https://openai.github.io/openai-agents-js/guides/human-in-the-loop/)
- OpenHands: [SDK architecture](https://github.com/OpenHands/docs/blob/main/sdk/arch/overview.mdx)
- Goose: [repository](https://github.com/aaif-goose/goose),
  [recipes](https://github.com/aaif-goose/goose/blob/main/documentation/docs/guides/recipes/recipe-reference.md)
- OpenCode: [server](https://opencode.ai/docs/server/),
  [SDK](https://opencode.ai/docs/sdk/),
  [permissions](https://opencode.ai/docs/permissions/)
- Codex: [SDK](https://developers.openai.com/codex/sdk),
  [app-server](https://developers.openai.com/codex/app-server),
  [sandbox](https://developers.openai.com/codex/sandbox)
