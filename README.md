# pi-jev-context-curator

A [pi](https://pi.dev) extension that curates the context sent to the LLM before each call — using **TypeSafe AI's Jev model** to decide which context is actually needed.

## What it does

Before every LLM call, pi fires the `context` event with the full message list. This extension:

1. Groups messages into **units** — an assistant tool-call message plus its tool results stay together as one atomic unit, so curation never orphans a tool result.
2. Checks each unit against the **judgment checkpoint**: every unit Jev has already judged is recorded by content fingerprint, so past decisions are reused and the same data is never sent to Jev twice.
3. Sends only the **new units** (those after the checkpoint) to Jev's `/v1/systemone` endpoint. One primary yes/no (`noul`) question decides keep/remove, alongside two native `choice` questions that classify the best keep reason and removal reason. The primary `noul` remains authoritative.
4. Units Jev rejects are omitted from the current model context and that decision is re-applied on subsequent `context` events (pi itself only lets extensions transform the per-call payload, not edit the stored session).
5. Every newly removed unit is also written as a durable, session-scoped pi entry. It appears as a collapsed `[jev removed]` record and can be expanded to inspect the removed text. The `/removed` popup shows the selected removal reason; these records are display-only and are not sent back to the LLM.

Jev is a good fit here: it returns calibrated probabilities in ~70–500ms, costs $42/B input tokens with free outputs, and is purpose-built for this kind of structured semantic judgment.

Because each unit is judged once, the per-turn Jev cost stays tiny (usually 1–3 new units) no matter how long the session gets.

## Safety: fail-open by design

- **No API key in hosted mode** → context passes through untouched (one warning per session). SemIf local mode needs no key.
- **Any Jev API error / timeout / rate-limit** → context passes through untouched, and the new units are retried on the next event (nothing is recorded).
- **The primary `noul` answer controls keep/remove**; reason probes only explain the decision and never override it. Missing/non-numeric primary answers are kept. Summaries—including summaries created earlier—are explicitly protected by the prompt.
- **System messages are always kept** (they define tools and prompt sections) and are never judged.
- **The latest unit (current user request) is always kept** for the current turn; it becomes eligible for judgment once newer messages arrive.
- **Token floor**: curation only runs when estimated context exceeds `CURATOR_JEV_MIN_TOKENS` (default 8000), so small contexts pay no extra latency.
- **Configurable frequency**: Jev queries run every fifth context call by default, or every Nth call with `CURATOR_JEV_FREQUENCY` / `/jev-context-curator frequency <n>`. Previously judged removals are still applied on calls between Jev queries.
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
  index.ts     extension entry — registers the /jev-context-curator command and the context handler
  config.ts    constants + env-based configuration
  keystore.ts  API key resolution and persistence (~/.pi/curator-jev.json)
  units.ts     message introspection + grouping into curation units (+ fingerprints)
  checkpoint.ts  content-addressed record of judged units (each unit judged once)
  jev.ts       the Jev decision call (/v1/systemone)
  stats.ts     session cost + removal tracking
  context-inspection.ts  session-scoped Jev decision index
```

pi discovers the extension via `extensions/curator-jev/index.ts`; the other
modules are imported relatively and are never loaded as extensions themselves.

## Configuration

| Env var | Default | Description |
|---|---|---|
| `TYPESAFE_API_KEY` | — | API key from `console.typesafe.ai/settings/keys` for hosted mode; SemIf local mode does not need one. |
| `TYPESAFE_BASE_URL` | `https://api.typesafe.ai` | Override for proxies/mirrors. |
| `CURATOR_JEV_PROVIDER` | `typesafe` | Set to `semif` to force local mode (no API key). Prefer `/jev-context-curator mode semif`. See [Self-hosted SemIf](#self-hosted-semif). |
| `SEMIF_BASE_URL` | `http://127.0.0.1:3000` | SemIf URL; must be loopback. Managed launch uses plain HTTP origin; omitted port defaults to `3000`. |
| `JEV_MODEL` | `jev-latest` (`semif` in local mode) | Jev model alias or pinned version. |
| `CURATOR_JEV_THRESHOLD` | `0.4` | Keep a unit when Jev's "needed" probability ≥ this. Lower is more conservative and keeps more context; env overrides saved settings. |
| `CURATOR_JEV_MIN_TOKENS` | `8000` | Only curate above this estimated context size; env overrides saved settings. |
| `CURATOR_JEV_FREQUENCY` | `5` | Run a new Jev query every Nth context/model call; `3` means every third call; env overrides saved settings. |
| `CURATOR_JEV_ENABLED` | `1` | Set to `0` to start disabled. |
| `CURATOR_JEV_DEBUG` | — | Set to `1` for per-turn curation logs. |

> **Note:** as of September 2026, TypeSafe AI's direct API is in **waitlisted early access** — hosted mode needs an approved key from `console.typesafe.ai`. Without one, hosted mode passes context through unchanged; SemIf local mode is available without a key.

## Self-hosted SemIf

Optional **mode** that runs the judge on a small open model on your own machine via [llama.cpp](https://github.com/ggml-org/llama.cpp)'s `llama-server`, instead of hosted TypeSafe. No TypeSafe key is read or sent. **Default is `typesafe` until you switch.**

```
/jev-context-curator mode                       # show current mode
/jev-context-curator mode semif                 # switch to local (guided setup if needed)
/jev-context-curator mode semif qwen3.5-4b      # ...with a specific model, skipping the picker
/jev-context-curator mode typesafe              # back to hosted; stops the server pi started
```

Published model measurements (hosted Jev scores 88.3% on the TypeSafe set):

| Model | Download | Authored | Perturbed | TypeSafe agreement |
|---|---|---|---|---|
| `minicpm5-2b` MiniCPM5 2B | 1.56 GB | 68.6% | 69.3% | 63.7% |
| `qwen3.5-4b` Qwen3.5 4B | 3.01 GB | 81.3% | 76.6% | 84.5% |

The picker marks one as **recommended** for your RAM (4B at 16 GB+, otherwise 2B). You choose.

`mode semif` does, in order:
1. **Detect safely:** reuse a server only if `/v1/models` identifies one of the supported model IDs (`minicpm5-2b` or `qwen3.5-4b`). A generic `/health` response is not enough. Manually launched servers need `--alias` set to the matching ID.
2. **Avoid collisions:** if the default loopback port is occupied by another service, automatically choose and remember a free loopback port. If you explicitly set `SEMIF_BASE_URL` and that endpoint is occupied by an unknown model/service, stop or move it; no context is sent there.
3. **Pick + confirm:** otherwise (needs `llama-server` installed, e.g. `brew install llama.cpp`) choose a model; already-downloaded ones are marked. Confirm before downloading.
4. **Launch:** weights go to `~/.pi/curator-jev/semif/models` (pinned GGUF, resumable), then `llama-server` starts on loopback in the background (log: `server.log`). Pi verifies the model ID before switching curation over. Failure leaves current mode.

The mode, model, and automatically selected port are saved. On startup a saved `semif` mode reuses a verified server or starts the already-downloaded model; it never downloads without asking. The server pi started is stopped when pi exits. `CURATOR_JEV_PROVIDER=semif` also forces local mode via env.

- **How it judges:** each keep/remove question is answered from the model's option-letter logprobs (one token), not generated text. This local readout runs over llama-server; it is not hosted Jev's exact path.
- **Loopback only:** non-loopback/malformed URLs, URL credentials and redirects are refused; context then passes through untouched.
- **Failure behavior:** server down, timeout, bad response → affected context is kept and retried later.
- **Request size:** local sends a ~4k-token `state` per call (server context 8192) vs 28k hosted.
- **Cost:** `$0 API-billed`; your own compute is not metered.
- **Licenses:** weights are third-party; check each model's license on Hugging Face.
- **Verification:** automated tests stub HTTP; the real llama-server and MiniCPM5 2B readout were smoke-tested on Apple silicon. Qwen inference was not tested here.

## API keys

You don't have to export the key in your shell. Three sources, in priority order:

1. `/jev-context-curator set-key <key>` — active immediately, and persisted to `~/.pi/curator-jev.json` for future sessions (plaintext, mode `0600` — same convention as pi's own `models.json`).
2. `TYPESAFE_API_KEY` environment variable.
3. The persisted key from a previous `/jev-context-curator set-key`.

Run `/jev-context-curator clear-key` to remove the key from both the session and the config file.

## Commands

```
/jev-context-curator status            # show state, settings, key source, checkpoint size, session savings, session cost
/jev-context-curator stats             # detailed removal + cost stats for the session
/jev-context-curator inspect           # inspect Jev's kept and removed context decisions
/jev-context-curator on | off          # toggle curation for the session
/jev-context-curator set-key <key>     # add your TypeSafe API key (persisted to ~/.pi/curator-jev.json)
/jev-context-curator clear-key         # remove the stored API key
/jev-context-curator cost              # show Jev spend this session
/jev-context-curator reset             # clear the judgment checkpoint (everything gets re-judged)
/jev-context-curator threshold 0.8     # keep only units Jev is ≥80% sure a future response needs
/jev-context-curator min-tokens 12000  # raise the token floor
/jev-context-curator frequency 3       # query Jev every third context/model call
```

`threshold`, `min-tokens`, and `frequency` save to `~/.pi/curator-jev.json` and persist across sessions. Their matching `CURATOR_JEV_*` env vars override saved settings at startup.

## Removal stats

`/jev-context-curator stats` shows, for the session:

- units judged, and how many were kept vs permanently removed,
- total messages / estimated tokens discarded,
- cumulative messages and estimated tokens removed this session,
- Jev calls, input tokens, and estimated cost.

Jev's context decisions are stored per pi session as durable extension entries. In
the TUI, expand each `[jev removed]` entry in the transcript to view its full text.
The `inspect` command opens a compact dashboard of kept and removed units; select
an item and press Enter to inspect its full text and Jev's reason. Inspected
entries are display-only and are never included in future model context. The
legacy `removed` command remains an alias for `inspect`.

## Cost

Jev bills **$42 per billion input tokens**; outputs are free. Each curation call is small (the truncated transcript), so a single call typically costs a fraction of a cent. The extension tracks usage from Jev's `usage.input_tokens` response field and shows:

- per-call cost in debug mode (`CURATOR_JEV_DEBUG=1`),
- a UI notification after context is removed showing cumulative savings, for example `curated context — cumulative removed: 2,400 tokens (8 messages)`,
- cumulative estimated tokens removed in `/jev-context-curator status`, plus the next scheduled Jev check.

## How the decision prompt works

Jev's `/v1/systemone` takes a `state` (the numbered new units after the checkpoint — never the whole transcript, so the same data is never sent twice; capped to fit Jev's 32k-token budget, newest units first) plus a map of questions. Since question *keys* aren't sent to the model, each question's instructions name the unit number explicitly:

```json
"u3": {
  "type": "noul",
  "instructions": "Consider ONLY context unit [3] (assistant+toolResult:bash) in the transcript above. Remove only if one specific reason fits: duplicate, fully superseded, transient chatter, redundant intermediate output, or completed detail with no reusable value. Keep durable instructions, facts, code, useful results, and all summaries. If no reason clearly fits, keep it …",
  "criteria": { "true": "Keep: useful or no specific reason fits",
                "false": "Remove only when one specific reason fits; never remove a summary" }
}
```

The primary response's `noul` value is the probability of "keep" — units below threshold are dropped. Two `choice` responses select the best keep and removal explanations; the explanation corresponding to the primary decision is saved. If no valid choice is returned, the popup says no clear reason was identified. Explanations are informational only and never change the primary keep/remove result.

## Publishing

Publishing is automated by [`.github/workflows/publish.yml`](.github/workflows/publish.yml)
when a `v*.*.*` tag is pushed to a commit on `main`. The workflow derives the npm version
from the tag, installs dependencies, typechecks the TypeScript source, validates the
package tarball, and publishes with npm trusted publishing and provenance. Configure the
repository as a trusted publisher for `pi-jev-context-curator` on npm before the first
release.

## License

MIT
