# pi-jev-context-curator

A [pi](https://pi.dev) extension that curates the context sent to the LLM before each call — using **TypeSafe AI's Jev model** to decide which context is actually needed.

## What it does

Before every LLM call, pi fires the `context` event with the full message list. This extension:

1. Groups messages into **units** — an assistant tool-call message plus its tool results stay together as one atomic unit, so curation never orphans a tool result.
2. Sends the numbered transcript to Jev's `/v1/systemone` endpoint with **one yes/no (`noul`) question per unit**: *"Will the assistant's next response likely need this unit?"* All questions evaluate in parallel in a single pass.
3. Drops units Jev scores below the keep threshold (default 0.5) and returns the filtered list to pi.

Jev is a good fit here: it returns calibrated probabilities in ~70–500ms, costs $42/B input tokens with free outputs, and is purpose-built for this kind of structured semantic judgment.

## Safety: fail-open by design

- **No API key** → context passes through untouched (one warning per session).
- **Any Jev API error / timeout / rate-limit** → context passes through untouched.
- **System messages are always kept** (they define tools and prompt sections).
- **The latest unit (current user request) is always kept.**
- **Token floor**: curation only runs when estimated context exceeds `CURATOR_JEV_MIN_TOKENS` (default 8000), so small contexts pay no extra latency.
- The Jev call goes over plain `fetch`, not pi's model registry — it never re-triggers `context` handlers, so there's no recursion.

## Install

As a pi package (auto-discovers `extensions/`):

```bash
pi install git:github.com/Shashank-H/pi-jev-context-curator
```

Or drop `extensions/curator-jev/` into `~/.pi/agent/extensions/` (hot-reloads with `/reload`).

## Layout

```
extensions/curator-jev/
  index.ts     extension entry — registers the /curator-jev command and the context handler
  config.ts    constants + env-based configuration
  keystore.ts  API key resolution and persistence (~/.pi/curator-jev.json)
  units.ts     message introspection + grouping into curation units
  jev.ts       the Jev decision call (/v1/systemone)
  stats.ts     session cost tracking
```

pi discovers the extension via `extensions/curator-jev/index.ts`; the other
modules are imported relatively and are never loaded as extensions themselves.

## Configuration

| Env var | Default | Description |
|---|---|---|
| `TYPESAFE_API_KEY` | — | API key from `console.typesafe.ai/settings/keys`. One of the key sources is required; without it the extension is a no-op. |
| `TYPESAFE_BASE_URL` | `https://api.typesafe.ai` | Override for proxies/mirrors. |
| `JEV_MODEL` | `jev-latest` | Jev model alias or pinned version. |
| `CURATOR_JEV_THRESHOLD` | `0.5` | Keep a unit when Jev's "needed" probability ≥ this. Higher = more aggressive pruning. |
| `CURATOR_JEV_MIN_TOKENS` | `8000` | Only curate above this estimated context size. |
| `CURATOR_JEV_ENABLED` | `1` | Set to `0` to start disabled. |
| `CURATOR_JEV_DEBUG` | — | Set to `1` for per-turn curation logs. |

> **Note:** as of September 2026, TypeSafe AI's direct API is in **waitlisted early access** — you need an approved key from `console.typesafe.ai`. Until then the extension passes context through unchanged.

## API keys

You don't have to export the key in your shell. Three sources, in priority order:

1. `/curator-jev set-key <key>` — active immediately, and persisted to `~/.pi/curator-jev.json` for future sessions (plaintext, mode `0600` — same convention as pi's own `models.json`).
2. `TYPESAFE_API_KEY` environment variable.
3. The persisted key from a previous `/curator-jev set-key`.

Run `/curator-jev clear-key` to remove the key from both the session and the config file.

## Commands

```
/curator-jev status            # show state, settings, key source, and session cost
/curator-jev on | off          # toggle curation for the session
/curator-jev set-key <key>     # add your TypeSafe API key (persisted to ~/.pi/curator-jev.json)
/curator-jev clear-key          # remove the stored API key
/curator-jev cost               # show Jev spend this session
/curator-jev threshold 0.7     # keep only units Jev is ≥70% sure are needed
/curator-jev min-tokens 12000  # raise the token floor
```

## Cost

Jev bills **$42 per billion input tokens**; outputs are free. Each curation call is small (the truncated transcript), so a single call typically costs a fraction of a cent. The extension tracks usage from Jev's `usage.input_tokens` response field and shows:

- per-call cost in debug mode (`CURATOR_JEV_DEBUG=1`),
- running session totals in `/curator-jev status` and `/curator-jev cost`.

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
