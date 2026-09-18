# pi-jev-context-curator

A [pi](https://pi.dev) extension that curates the context sent to the LLM before each call — using **TypeSafe AI's Jev model** to decide which context is actually needed.

## What it does

Before every LLM call, pi fires the `context` event with the full message list. This extension:

1. Groups messages into **units** — an assistant tool-call message plus its tool results stay together as one atomic unit, so curation never orphans a tool result.
2. Sends the numbered transcript to Jev's `/v1/systemone` endpoint with **one yes/no (`noul`) question per unit**: *"Will the assistant's next response likely need this unit?"* All questions evaluate in parallel in a single pass.
3. Drops units Jev scores below the keep threshold (default 0.5) and returns the filtered list to pi.

Jev is a good fit here: it returns calibrated probabilities in ~70–500ms, costs $42/B input tokens with free outputs, and is purpose-built for this kind of structured semantic judgment.

## Safety: fail-open by design

- **No `TYPESAFE_API_KEY`** → context passes through untouched (one warning per session).
- **Any Jev API error / timeout / rate-limit** → context passes through untouched.
- **System messages are always kept** (they define tools and prompt sections).
- **The latest unit (current user request) is always kept.**
- **Token floor**: curation only runs when estimated context exceeds `JEV_CURATOR_MIN_TOKENS` (default 8000), so small contexts pay no extra latency.
- The Jev call goes over plain `fetch`, not pi's model registry — it never re-triggers `context` handlers, so there's no recursion.

## Install

As a pi package (auto-discovers `extensions/`):

```bash
pi install git:github.com/Shashank-H/pi-jev-context-curator
```

Or drop `extensions/jev-context-curator.ts` into `~/.pi/agent/extensions/` (hot-reloads with `/reload`).

## Configuration

| Env var | Default | Description |
|---|---|---|
| `TYPESAFE_API_KEY` | — | **Required.** API key from `console.typesafe.ai/settings/keys`. Without it, the extension is a no-op. |
| `TYPESAFE_BASE_URL` | `https://api.typesafe.ai` | Override for proxies/mirrors. |
| `JEV_MODEL` | `jev-latest` | Jev model alias or pinned version. |
| `JEV_CURATOR_THRESHOLD` | `0.5` | Keep a unit when Jev's "needed" probability ≥ this. Higher = more aggressive pruning. |
| `JEV_CURATOR_MIN_TOKENS` | `8000` | Only curate above this estimated context size. |
| `JEV_CURATOR_ENABLED` | `1` | Set to `0` to start disabled. |
| `JEV_CURATOR_DEBUG` | — | Set to `1` for per-turn curation logs. |

> **Note:** as of September 2026, TypeSafe AI's direct API is in **waitlisted early access** — you need an approved key from `console.typesafe.ai`. Until then the extension passes context through unchanged.

## Commands

```
/jev-curator status            # show state and settings
/jev-curator on | off          # toggle curation for the session
/jev-curator threshold 0.7    # keep only units Jev is ≥70% sure are needed
/jev-curator min-tokens 12000  # raise the token floor
```

## How the decision prompt works

Jev's `/v1/systemone` takes a `state` (the numbered transcript, truncated to fit its 32k-token cap — oldest units are excluded from the decision and kept) plus a map of questions. Since question *keys* aren't sent to the model, each question's instructions name the unit number explicitly:

```json
"u3": {
  "type": "noul",
  "instructions": "Consider ONLY context unit [3] (assistant+toolResult:bash) in the transcript above. Will the assistant's next response likely need the content of unit [3]? …",
  "criteria": { "true": "The next response likely depends on this unit's content",
                "false": "The next response can be produced without this unit" }
}
```

The response's `noul` value is the probability of "yes" — units below threshold are dropped.

## License

MIT
