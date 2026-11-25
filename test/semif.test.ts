import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
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

test("SemifServer.stop kills its server if graceful termination hangs", () => {
	const dir = mkdtempSync(join(tmpdir(), "semif-shutdown-"));
	const bin = join(dir, "bin");
	const pidFile = join(dir, "server.pid");
	mkdirSync(bin);
	const mockServer = join(dir, "mock-server.mjs");
	writeFileSync(mockServer, `
		import { createServer } from "node:http";
		import { writeFileSync } from "node:fs";
		const args = process.argv.slice(2);
		const arg = (name) => args[args.indexOf(name) + 1];
		writeFileSync(process.env.FAKE_SERVER_PID, String(process.pid));
		process.on("SIGTERM", () => {});
		createServer((req, res) => {
			res.setHeader("content-type", "application/json");
			if (req.url === "/health") res.end(JSON.stringify({ status: "ok" }));
			else if (req.url === "/v1/models") res.end(JSON.stringify({ data: [{ id: arg("--alias") }] }));
			else { res.statusCode = 404; res.end(); }
		}).listen(Number(arg("--port")), arg("--host"));
	`);
	writeFileSync(
		join(bin, "llama-server"),
		`#!/bin/sh\nif [ "$1" = "--version" ]; then echo test; exit 0; fi\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockServer)} "$@"\n`,
		{ mode: 0o755 },
	);
	const script = `
		import { mkdirSync, writeFileSync } from "node:fs";
		import { dirname } from "node:path";
		const semif = await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "extensions/curator-jev/semif.ts")).href)});
		const model = semif.MODELS[0];
		mkdirSync(dirname(semif.modelPath(model)), { recursive: true });
		writeFileSync(semif.modelPath(model), "test model");
		const baseUrl = await semif.freeLoopbackUrl();
		const server = new semif.SemifServer();
		const error = await server.start(model, baseUrl, () => {});
		if (error) throw new Error(error);
		if (!(await semif.inspectServer(baseUrl, 100)).ready) throw new Error("test server did not start");
		server.stop();
		const stoppedBy = Date.now() + 6000;
		while (Date.now() < stoppedBy && (await semif.inspectServer(baseUrl, 100)).listening) await new Promise((r) => setTimeout(r, 50));
		if ((await semif.inspectServer(baseUrl, 100)).listening) throw new Error("server survived stop");
		console.log("server stopped");
	`;
	try {
		const env: NodeJS.ProcessEnv = {
			...process.env,
			HOME: join(dir, "home"),
			PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
			CURATOR_JEV_CONFIG: join(dir, "config.json"),
			FAKE_SERVER_PID: pidFile,
		};
		delete env.CURATOR_JEV_PROVIDER;
		const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: process.cwd(), env, timeout: 12000 });
		assert.equal(output.toString().trim(), "server stopped");
	} finally {
		if (existsSync(pidFile)) {
			try { process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL"); } catch { /* already exited */ }
		}
		rmSync(dir, { recursive: true, force: true });
	}
});

test("free loopback URL uses an ephemeral available port", async () => {
	const url = await freeLoopbackUrl();
	assert.equal(new URL(url).hostname, "127.0.0.1");
	assert.ok(Number(new URL(url).port) > 0);
});
