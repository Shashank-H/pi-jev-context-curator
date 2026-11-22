import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { findModel, freeLoopbackUrl, inspectServer, managedServerUrl, MODELS, probe, recommend } from "../extensions/curator-jev/semif.ts";
import { softmax } from "../extensions/curator-jev/readout.ts";

test("recommend: 4B with headroom, 2B on small machines; user still picks any", () => {
	assert.equal(recommend(16).id, "qwen3.5-4b");
	assert.equal(recommend(8).id, "minicpm5-2b");
	assert.equal(findModel("qwen3.5-4b")?.name, "Qwen3.5 4B");
	assert.equal(findModel("nope"), undefined);
	assert.equal(MODELS.length, 2);
});

test("softmax sums to 1 and rejects invalid logits", () => {
	const p = softmax([0, 0, 0, 0]);
	assert.ok(Math.abs(p.reduce((a, b) => a + b) - 1) < 1e-9 && p[0] === 0.25);
	assert.throws(() => softmax([]), /invalid logits/);
	assert.throws(() => softmax([0, Number.NaN]), /invalid logits/);
});

test("identify only ready llama-server with supported model; detect other listeners", async () => {
	const mk = (health: string, status: number, model?: string) =>
		new Promise<{ url: string; close: () => void }>((r) => {
			const s = createServer((req, res) => {
				if (req.url === "/v1/models" && model) res.end(JSON.stringify({ data: [{ id: model }] }));
				else { res.statusCode = status; res.end(health); }
			}).listen(0, "127.0.0.1", () =>
				r({ url: `http://127.0.0.1:${(s.address() as { port: number }).port}`, close: () => s.close() }),
			);
		});
	const ok = await mk('{"status":"ok"}', 200, "qwen3.5-4b");
	const loading = await mk('{"error":"loading"}', 503, "qwen3.5-4b");
	const other = await mk("<html>", 200);
	const unsupported = await mk('{"status":"ok"}', 200, "some-other-model");
	assert.equal(await probe(ok.url, 2000), true);
	assert.equal((await inspectServer(loading.url, 2000)).modelId, "qwen3.5-4b");
	assert.equal(await probe(loading.url, 2000), false);
	assert.deepEqual(await inspectServer(other.url, 2000), { listening: true, ready: false, modelId: undefined });
	assert.equal(await probe(unsupported.url, 2000), false);
	ok.close(); loading.close(); other.close(); unsupported.close();
	assert.deepEqual(await inspectServer("http://127.0.0.1:1", 500), { listening: false, ready: false });
});

test("managed server URLs are normalized to bindable HTTP loopback origins", () => {
	assert.equal(managedServerUrl("http://localhost"), "http://127.0.0.1:3000");
	assert.equal(managedServerUrl("http://[::1]:9876"), "http://[::1]:9876");
	assert.equal(managedServerUrl("https://127.0.0.1:3000"), undefined);
	assert.equal(managedServerUrl("http://127.0.0.1:3000/prefix"), undefined);
});

test("free loopback URL uses an ephemeral available port", async () => {
	const url = await freeLoopbackUrl();
	assert.equal(new URL(url).hostname, "127.0.0.1");
	assert.ok(Number(new URL(url).port) > 0);
});
