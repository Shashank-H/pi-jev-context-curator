import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, it } from "node:test";
import { checkLoopbackUrl, loadConfig, type CuratorConfig } from "../extensions/curator-jev/config.ts";
import { askJev } from "../extensions/curator-jev/jev.ts";
import { createStats, formatStatsSummary, recordCall } from "../extensions/curator-jev/stats.ts";
import { fingerprintUnit, groupIntoUnits, type Unit } from "../extensions/curator-jev/units.ts";
import { JudgmentCheckpoint } from "../extensions/curator-jev/checkpoint.ts";

const ENV_KEYS = ["CURATOR_JEV_PROVIDER", "SEMIF_BASE_URL", "TYPESAFE_BASE_URL", "JEV_MODEL"];
const realFetch = globalThis.fetch;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
	globalThis.fetch = realFetch;
	for (const k of ENV_KEYS) {
		if (savedEnv[k] === undefined) delete process.env[k];
		else process.env[k] = savedEnv[k];
	}
});

const unit = (text: string, label = "user"): Unit => ({ messageIndexes: [0], label, text, alwaysKeep: false });
const cfgFor = (env: Record<string, string> = {}): CuratorConfig => {
	for (const k of ENV_KEYS) delete process.env[k];
	Object.assign(process.env, env);
	return loadConfig();
};
const local = (url?: string) => cfgFor({ CURATOR_JEV_PROVIDER: "semif", ...(url ? { SEMIF_BASE_URL: url } : {}) });

interface Call { url: string; init: RequestInit }
function stubFetch(respond: (call: Call) => Response | Promise<Response>): Call[] {
	const calls: Call[] = [];
	globalThis.fetch = (async (url: string, init: RequestInit) => {
		const call = { url: String(url), init };
		calls.push(call);
		return respond(call);
	}) as typeof fetch;
	return calls;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const answers = (noul: unknown, extra: Record<string, unknown> = {}) =>
	json({ answers: { u0: { type: "noul", noul }, ...extra }, usage: { input_tokens: 123 } });

/** Fake llama-server: P(first option) = pFirst for 2-option questions; otherwise option `pick` wins. */
const llama = (pFirst: number, pick = 0, usage: unknown = { prompt_tokens: 123 }, noUsage = false) => (call: Call) => {
	if (call.url.endsWith("/tokenize")) return json({ tokens: [1] });
	const user: string = JSON.parse(call.init.body as string).messages[1].content;
	const n = (user.match(/from: ([A-Z, ]+)\./)?.[1] ?? "A, B").split(", ").length;
	const lp = Array.from({ length: n }, (_, i) =>
		n === 2 ? Math.log(i === 0 ? pFirst : 1 - pFirst) : i === pick ? -0.01 : -20,
	);
	const top_logprobs = lp.map((logprob, i) => ({ token: String.fromCharCode(65 + i), logprob }));
	return json({ choices: [{ logprobs: { content: [{ top_logprobs }] } }], ...(noUsage ? {} : { usage }) });
};

describe("config / endpoint safety", () => {
	it("defaults to hosted TypeSafe, unchanged", () => {
		const c = cfgFor();
		assert.equal(c.provider, "typesafe");
		assert.equal(c.baseUrl, "https://api.typesafe.ai");
		assert.equal(c.model, "jev-latest");
		assert.equal(c.maxStateTokens, 28000);
		assert.equal(c.endpointError, undefined);
	});
	it("persists tuning settings; env vars take precedence", () => {
		const dir = mkdtempSync(join(tmpdir(), "curator-jev-"));
		try {
			const configFile = join(dir, "settings.json");
			const keystore = pathToFileURL(join(process.cwd(), "extensions/curator-jev/keystore.ts")).href;
			const config = pathToFileURL(join(process.cwd(), "extensions/curator-jev/config.ts")).href;
			const script = `
				const store = await import(${JSON.stringify(keystore)});
				const config = await import(${JSON.stringify(config)});
				store.persistUserSettings({ frequency: 2, minTokens: 12000, threshold: 0.7 });
				const saved = config.loadConfig();
				process.env.CURATOR_JEV_FREQUENCY = "4";
				process.env.CURATOR_JEV_MIN_TOKENS = "16000";
				process.env.CURATOR_JEV_THRESHOLD = "0.8";
				const overridden = config.loadConfig();
				console.log(JSON.stringify([saved.frequency, saved.minTokens, saved.threshold, overridden.frequency, overridden.minTokens, overridden.threshold]));
			`;
			const env: NodeJS.ProcessEnv = { ...process.env, CURATOR_JEV_CONFIG: configFile };
			for (const key of ["CURATOR_JEV_PROVIDER", "CURATOR_JEV_THRESHOLD", "CURATOR_JEV_MIN_TOKENS", "CURATOR_JEV_FREQUENCY"]) delete env[key];
			const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: process.cwd(), env });
			assert.deepEqual(JSON.parse(output.toString()), [2, 12000, 0.7, 4, 16000, 0.8]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("semif uses loopback default, local model, smaller state budget", () => {
		const c = local();
		assert.equal(c.provider, "semif");
		assert.equal(c.baseUrl, "http://127.0.0.1:3000");
		assert.equal(c.model, "semif");
		assert.ok(c.maxStateTokens <= 12000);
		assert.equal(c.endpointError, undefined);
	});
	it("ignores TYPESAFE_BASE_URL in local mode", () => {
		const c = cfgFor({ CURATOR_JEV_PROVIDER: "semif", TYPESAFE_BASE_URL: "https://evil.example" });
		assert.equal(c.baseUrl, "http://127.0.0.1:3000");
	});
	it("accepts only explicit loopback http(s) hosts", () => {
		for (const ok of ["http://127.0.0.1:3000", "http://localhost:3000", "http://[::1]:3000", "https://localhost"]) {
			assert.equal(checkLoopbackUrl(ok), undefined, ok);
		}
		for (const bad of [
			"not a url",
			"",
			"ftp://127.0.0.1",
			"http://example.com",
			"http://10.0.0.5:3000",
			"http://0.0.0.0:3000",
			"http://127.0.0.1.evil.com",
			"http://localhost.evil.com",
			"http://user:pw@127.0.0.1:3000",
			"http://evil.com@127.0.0.1:3000",
			"http://127.0.0.1@evil.com",
		]) {
			assert.ok(checkLoopbackUrl(bad), bad);
		}
	});
	it("remote / malformed SEMIF_BASE_URL sets endpointError", () => {
		assert.ok(local("https://api.example.com").endpointError);
		assert.ok(local("garbage").endpointError);
	});
});

describe("askJev: hosted", () => {
	it("sends bearer key to /v1/systemone and parses noul + usage", async () => {
		const c = cfgFor();
		const calls = stubFetch(() =>
			answers(0.9, { why_keep_0: { choice: "instruction" } }),
		);
		const d = await askJev([unit("hi")], "tskey", c, undefined);
		assert.equal(calls[0].url, "https://api.typesafe.ai/v1/systemone");
		assert.equal((calls[0].init.headers as Record<string, string>).Authorization, "Bearer tskey");
		assert.deepEqual([...d!.keep], [0]);
		assert.equal(d!.inputTokens, 123);
		assert.equal(d!.reasons.get(0), "User instruction, preference, or constraint");
	});
	it("no key => no request, null (pass-through)", async () => {
		const calls = stubFetch(() => answers(0.9));
		assert.equal(await askJev([unit("hi")], undefined, cfgFor(), undefined), null);
		assert.equal(calls.length, 0);
	});
});

describe("askJev: semif", () => {
	it("makes keyless request to loopback; never leaks a supplied TypeSafe key", async () => {
		const c = local();
		const calls = stubFetch(llama(0.05, 0));
		const d = await askJev([unit("hi")], "SECRET-TS-KEY", c, undefined);
		for (const call of calls) {
			assert.ok(call.url.startsWith("http://127.0.0.1:3000/"));
			assert.ok(!call.url.endsWith("/v1/systemone"));
			const headers = call.init.headers as Record<string, string>;
			assert.deepEqual(Object.keys(headers).map((h) => h.toLowerCase()), ["content-type"]);
			assert.ok(!JSON.stringify(call.init).includes("SECRET-TS-KEY"));
			assert.equal(call.init.redirect, "error");
		}
		assert.ok(calls.some((c) => c.url.endsWith("/v1/chat/completions")));
		assert.deepEqual([...d!.keep], []); // 0.05 < 0.4 threshold => remove
		assert.deepEqual(d!.judged, [0]);
		assert.ok(d!.reasons.get(0));
	});
	it("rejected endpoint => no request at all", async () => {
		const calls = stubFetch(llama(0.9));
		for (const url of ["https://api.example.com", "http://192.168.1.2:3000", "bad"]) {
			assert.equal(await askJev([unit("x")], undefined, local(url), undefined), null);
		}
		assert.equal(calls.length, 0);
	});
	it("bounds state to the local budget without splitting units", async () => {
		const c = local();
		const calls = stubFetch(llama(0.9));
		const many = Array.from({ length: 200 }, (_, i) => unit("x".repeat(1400) + i));
		const d = await askJev(many, undefined, c, undefined);
		const body = JSON.parse(calls.find((x) => x.url.endsWith("/v1/chat/completions"))!.init.body as string);
		assert.ok(body.messages[1].content.length <= c.maxStateTokens * 4 + 4000);
		assert.ok(d!.judged.length < many.length);
		assert.equal(d!.judged.at(-1), many.length - 1); // newest first
	});
	it("does not fabricate usage when the server omits it", async () => {
		stubFetch(llama(0.9, 0, undefined, true));
		assert.equal((await askJev([unit("x")], undefined, local(), undefined))!.inputTokens, 0);
	});
});

describe("response parsing: conservative keep", () => {
	const run = async (body: unknown) => {
		stubFetch(() => json(body));
		return askJev([unit("x")], "k", cfgFor(), undefined);
	};
	it("threshold boundary", async () => {
		assert.equal((await run({ answers: { u0: { noul: 0.4 } } }))!.keep.has(0), true);
		assert.equal((await run({ answers: { u0: { noul: 0.39 } } }))!.keep.has(0), false);
	});
	for (const bad of [undefined, null, "0.9", NaN, -1, 1.5, {}]) {
		it(`keeps on invalid noul ${JSON.stringify(bad)}`, async () => {
			const d = await run({ answers: { u0: { noul: bad } } });
			assert.equal(d!.keep.has(0), true);
		});
	}
	it("keeps when the answer is missing; unknown reason => no clear reason", async () => {
		const d = await run({ answers: {} });
		assert.equal(d!.keep.has(0), true);
		assert.equal(d!.reasons.get(0), "No clear reason identified");
	});
	it("reason probes never override the primary decision", async () => {
		const d = await run({ answers: { u0: { noul: 0.05 }, why_keep_0: { choice: "fact" }, why_remove_0: { choice: "nonsense" } } });
		assert.equal(d!.keep.has(0), false);
		assert.equal(d!.reasons.get(0), "No clear reason identified");
	});
	it("no answers object => null", async () => {
		assert.equal(await run({}), null);
	});
});

describe("failure and recovery (fail open, nothing recorded)", () => {
	for (const cfgName of ["hosted", "local"] as const) {
		const mk = () => (cfgName === "local" ? local() : cfgFor());
		it(`${cfgName}: connection refused, non-2xx, malformed JSON => null; later retry works`, async () => {
			const c = mk();
			stubFetch(() => {
				throw new TypeError("fetch failed: ECONNREFUSED");
			});
			assert.equal(await askJev([unit("x")], "k", c, undefined), null);
			stubFetch(() => json({ error: "x" }, 500));
			assert.equal(await askJev([unit("x")], "k", c, undefined), null);
			stubFetch(() => json({}, 429));
			assert.equal(await askJev([unit("x")], "k", c, undefined), null);
			stubFetch(() => new Response("{not json"));
			assert.equal(await askJev([unit("x")], "k", c, undefined), null);
			stubFetch(cfgName === "local" ? llama(0.9) : () => answers(0.9));
			assert.deepEqual([...(await askJev([unit("x")], "k", c, undefined))!.keep], [0]);
		});
		it(`${cfgName}: caller abort => null`, async () => {
			const ac = new AbortController();
			stubFetch(({ init }) => new Promise((_, rej) => {
				if (init.signal!.aborted) rej(new Error("aborted"));
				init.signal!.addEventListener("abort", () => rej(new Error("aborted")));
			}));
			const p = askJev([unit("x")], "k", mk(), ac.signal);
			ac.abort(new Error("stop"));
			assert.equal(await p, null);
		});
	}
});

describe("stats / accounting", () => {
	it("local calls track tokens but are not billed", () => {
		const s = createStats();
		assert.equal(recordCall(s, 1_000_000, false), 0);
		assert.equal(s.costUsd, 0);
		assert.equal(s.inputTokens, 1_000_000);
		const r = formatStatsSummary(s, { unitsJudged: 0, unitsRemoved: 0, messagesRemoved: 0, tokensRemoved: 0, sessionSavedMessages: 0, sessionSavedTokens: 0, lastTotalMessages: 0, lastTotalTokens: 0, lastRemovedMessages: 0, lastRemovedTokens: 0 }, true);
		assert.match(r, /semif/);
		assert.match(r, /not metered/);
		assert.doesNotMatch(r, /TypeSafe/);
	});
	it("hosted calls still priced", () => {
		assert.equal(recordCall(createStats(), 1_000_000), 0.042);
	});
});

describe("curation invariants (unchanged units/checkpoint)", () => {
	const msgs = [
		{ role: "system", content: "sys" },
		{ role: "user", content: "q1" },
		{ role: "assistant", content: [{ type: "toolCall", id: "1", name: "bash" }] },
		{ role: "toolResult", toolName: "bash", content: "out" },
		{ role: "toolResult", toolName: "bash", content: "out2" },
		{ role: "assistant", content: "done" },
		{ role: "user", content: "q2" },
	] as never[];
	it("system/user units always kept; tool call + results stay atomic", () => {
		const u = groupIntoUnits(msgs);
		assert.equal(u.length, 5);
		assert.deepEqual(u[2].messageIndexes, [2, 3, 4]);
		assert.deepEqual(u.map((x) => x.alwaysKeep), [true, true, false, false, true]);
	});
	it("checkpoint reuses decisions by fingerprint and clears on reset", () => {
		const cp = new JudgmentCheckpoint();
		const [, , tool] = groupIntoUnits(msgs);
		assert.equal(cp.get(fingerprintUnit(tool)), undefined);
		cp.record(fingerprintUnit(tool), false);
		assert.equal(cp.get(fingerprintUnit(tool)), false);
		cp.clear();
		assert.equal(cp.get(fingerprintUnit(tool)), undefined);
	});
});
