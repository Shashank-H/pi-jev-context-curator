# pi-jev-context-curator

A [pi](https://pi.dev) extension that curates the context sent to the LLM before each call — using **TypeSafe AI's Jev model** to decide which context is actually needed.

## What it does

Before every LLM call, pi fires the `context` event with the full message list. This extension:

1. Groups messages into **units** — an assistant tool-call message plus its tool results stay together as one atomic unit, so curation never orphans a tool result.
2. Checks each unit against the **judgment checkpoint**: every unit Jev has already judged is recorded by content fingerprint, so past decisions are reused and the same data is never sent to Jev twice.
3. Sends only the **new units** (those after the checkpoint) to Jev's `/v1/systemone` endpoint with **one yes/no (`noul`) question per unit**: *"Will ANY future response in this conversation likely need this unit?"* All questions evaluate in parallel in a single pass.
4. Units Jev rejects are **permanently discarded** from what the model sees — the removal is re-applied on every subsequent `context` event (pi itself only lets extensions transform the per-call payload, not edit the stored session).

Jev is a good fit here: it returns calibrated probabilities in ~70–500ms, costs $42/B input tokens with free outputs, and is purpose-built for this kind of structured semantic judgment.

Because each unit is judged once, the per-turn Jev cost stays tiny (usually 1–3 new units) no matter how long the session gets.

## Safety: fail-open by design

- **No API key** → context passes through untouched (one warning per session).
- **Any Jev API error / timeout / rate-limit** → context passes through untouched, and the new units are retried on the next event (nothing is recorded).
- **A "no" requires confidence**: the question is framed for permanent removal, so on uncertainty Jev should answer yes; non-numeric/missing answers are always kept.
- **System messages are always kept** (they define tools and prompt sections) and are never judged.
- **The latest unit (current user request) is always kept** for the current turn; it becomes eligible for judgment once newer messages arrive.
- **Token floor**: curation only runs when estimated context exceeds `CURATOR_JEV_MIN_TOKENS` (default 8000), so small contexts pay no extra latency.
- The Jev call goes over plain `fetch`, not pi's model registry — it never re-triggers `context` handlers, so there's no recursion.
- The checkpoint is cleared on `session_start`, so judgments never leak across sessions.

## Install

As a pi package from npm (auto-discovers `extensions/`):

```bash
pi install npm:pi-jev-context-curator
```

The package is also tagged with `pi-package`, so it is eligible for discovery in the [pi package gallery](https://pi.dev/packages).

For development or before an npm release, install directly from GitHub:

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
  units.ts     message introspection + grouping into curation units (+ fingerprints)
  checkpoint.ts  content-addressed record of judged units (each unit judged once)
  jev.ts       the Jev decision call (/v1/systemone)
  stats.ts     session cost + removal tracking
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
/curator-jev status            # show state, settings, key source, checkpoint size, discarded totals, session cost
/curator-jev stats             # detailed removal + cost stats for the session
/curator-jev on | off          # toggle curation for the session
/curator-jev set-key <key>     # add your TypeSafe API key (persisted to ~/.pi/curator-jev.json)
/curator-jev clear-key          # remove the stored API key
/curator-jev cost               # show Jev spend this session
/curator-jev reset              # clear the judgment checkpoint (everything gets re-judged)
/curator-jev threshold 0.7     # keep only units Jev is ≥70% sure a future response needs
/curator-jev min-tokens 12000  # raise the token floor
```

## Removal stats

`/curator-jev stats` shows, for the session:

- units judged, and how many were kept vs permanently removed,
- total messages / estimated tokens discarded,
- the last curation pass: total context → removed vs kept,
- Jev calls, input tokens, and estimated cost.

## Cost

Jev bills **$42 per billion input tokens**; outputs are free. Each curation call is small (the truncated transcript), so a single call typically costs a fraction of a cent. The extension tracks usage from Jev's `usage.input_tokens` response field and shows:

- per-call cost in debug mode (`CURATOR_JEV_DEBUG=1`),
- running session totals in `/curator-jev status` and `/curator-jev cost`.

## How the decision prompt works

Jev's `/v1/systemone` takes a `state` (the numbered new units after the checkpoint — never the whole transcript, so the same data is never sent twice; capped to fit Jev's 32k-token budget, newest units first) plus a map of questions. Since question *keys* aren't sent to the model, each question's instructions name the unit number explicitly:

```json
"u3": {
  "type": "noul",
  "instructions": "Consider ONLY context unit [3] (assistant+toolResult:bash) in the transcript above. Will ANY future response in this conversation likely need the content of unit [3]? This unit will be PERMANENTLY discarded if you answer no, so answer yes if there is any plausible future need …",
  "criteria": { "true": "Some future response may need this unit's content — keep it",
                "false": "No future response will need this unit — safe to permanently discard" }
}
```

The response's `noul` value is the probability of "yes" — units below threshold are dropped.

## Publishing

Publishing is automated by [`.github/workflows/publish.yml`](.github/workflows/publish.yml)
when a `v*.*.*` tag is pushed. The tag must match the version in `package.json`.
The workflow uses npm trusted publishing with provenance; configure the repository as a
trusted publisher for `pi-jev-context-curator` on npm before the first release.

## License

MIT
