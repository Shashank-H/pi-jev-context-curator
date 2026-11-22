/**
 * SemIf (formerly OpenJev) local mode: small open models served by llama.cpp's
 * `llama-server` on loopback, read out with direct logprobs (readout.ts).
 * Flow: detect running server -> pick model (recommended, user chooses) ->
 * confirm download -> download -> launch -> wait healthy. Stops with pi.
 * Everything lives under ~/.pi/curator-jev/semif. Models are CC/Apache-style
 * upstream GGUFs pinned by commit; weights are never bundled.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, renameSync, statSync } from "node:fs";
import { homedir, totalmem } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";

const HOME = join(homedir(), ".pi", "curator-jev", "semif");
const LOG = join(HOME, "server.log");
export const LLAMA_INSTALL = "brew install llama.cpp   (or see https://github.com/ggml-org/llama.cpp)";

export interface SemifModel {
	id: string;
	name: string;
	sizeGb: number;
	/** Pinned GGUF (Q4_K_M / Q8_0 builds used by openjev.com). */
	url: string;
	file: string;
	/** Published quality from openjev.com: balanced accuracy on authored set; agreement with TypeSafe on 102 public rows. */
	authored: number;
	typesafe: number;
}

export const MODELS: SemifModel[] = [
	{
		id: "minicpm5-2b",
		name: "MiniCPM5 2B",
		sizeGb: 1.56,
		url: "https://huggingface.co/openbmb/MiniCPM5-2B-GGUF/resolve/2079a22f3beaa4e306449978533478fe0522f4b3/MiniCPM5-2B-Q4_K_M.gguf",
		file: "minicpm5-2b.gguf",
		authored: 68.6,
		typesafe: 63.7,
	},
	{
		id: "qwen3.5-4b",
		name: "Qwen3.5 4B",
		sizeGb: 3.01,
		url: "https://huggingface.co/bartowski/Qwen_Qwen3.5-4B-GGUF/resolve/4168f45a16a1290d65a4ec0fa312ae917a4c15d6/Qwen_Qwen3.5-4B-Q4_K_M.gguf",
		file: "qwen3.5-4b.gguf",
		authored: 81.3,
		typesafe: 84.5,
	},
];

export const findModel = (id: string | undefined) => MODELS.find((m) => m.id === id);
export const modelPath = (m: SemifModel) => join(HOME, "models", m.file);
/** A finished download only exists under its final name (downloads go to .part first). */
export const isInstalled = (m: SemifModel) => existsSync(modelPath(m));
export const ramGb = () => Math.round(totalmem() / 2 ** 30);

/** Recommend by RAM: the 4B is clearly more accurate but needs headroom (model + 8k context + your editor/browser). */
export const recommend = (ram = ramGb()): SemifModel => (ram >= 16 ? MODELS[1] : MODELS[0]);

export const hasLlamaServer = (): boolean => spawnSync("llama-server", ["--version"], { stdio: "ignore" }).status === 0;

export function describe(m: SemifModel, rec: SemifModel, ram = ramGb()): string {
	return [
		`${m.name} — ${m.sizeGb} GB download`,
		`quality ${m.authored}% authored / ${m.typesafe}% agreement with TypeSafe`,
		m.id === rec.id ? `recommended for your ${ram} GB machine` : undefined,
		isInstalled(m) ? "already downloaded" : undefined,
	]
		.filter(Boolean)
		.join(" · ");
}

export const confirmText = (m: SemifModel, baseUrl: string): string =>
	[
		`No SemIf server found at ${baseUrl}. Set up ${m.name} locally?`,
		isInstalled(m) ? "  • model already downloaded — just starting llama-server" : `  • download ${m.name} (~${m.sizeGb} GB) to ${modelPath(m)}`,
		"  • start llama-server on loopback only (stopped when pi exits)",
		"Models are third-party weights; check their license on Hugging Face (openjev.com's lab models are not Jev).",
	].join("\n");

/** True when a llama-server is up and finished loading its model. */
export interface ServerInfo {
	listening: boolean;
	ready: boolean;
	modelId?: string;
}

/** Identify the listener, not merely an open port or generic /health response. */
export async function inspectServer(baseUrl: string, timeoutMs = 5000): Promise<ServerInfo> {
	let health: Response;
	try {
		health = await fetch(`${baseUrl}/health`, { redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
	} catch {
		return { listening: false, ready: false };
	}
	let modelId: string | undefined;
	try {
		const res = await fetch(`${baseUrl}/v1/models`, { redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
		if (res.ok) {
			const body = (await res.json()) as { data?: { id?: string }[] };
			modelId = body.data?.[0]?.id;
		}
	} catch {
		// Health endpoint may belong to an unrelated service; do not assume a model.
	}
	let ready = false;
	try {
		ready = health.ok && ((await health.json()) as { status?: string }).status === "ok";
	} catch {
		// A listener with a non-llama health response is occupied, but not usable.
	}
	return { listening: true, ready, modelId };
}

export async function probe(baseUrl: string, timeoutMs = 5000): Promise<boolean> {
	const info = await inspectServer(baseUrl, timeoutMs);
	return info.ready && MODELS.some((m) => m.id === info.modelId);
}

/** Get an unused loopback port when default port belongs to an unrelated service. */
export function freeLoopbackUrl(): Promise<string> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") return server.close(() => reject(new Error("could not allocate loopback port")));
			const url = `http://127.0.0.1:${address.port}`;
			server.close((error) => (error ? reject(error) : resolve(url)));
		});
	});
}

export class SemifServer {
	private child: ChildProcess | undefined;
	private download: ChildProcess | undefined;
	private generation = 0;
	get owned(): boolean {
		return !!this.child && this.child.exitCode === null;
	}

	/** Download if needed, start llama-server, wait until healthy. Returns an error string on failure. */
	async start(
		m: SemifModel,
		baseUrl: string,
		progress: (msg: string) => void,
		onPortConflict?: () => Promise<string>,
		retries = 0,
	): Promise<string | undefined> {
		const generation = this.generation;
		mkdirSync(join(HOME, "models"), { recursive: true });
		const logFd = openSync(LOG, "a");
		const fail = (what: string) => `${what} — see ${LOG}`;
		try {
			if (!isInstalled(m)) {
				const part = `${modelPath(m)}.part`;
				const t = setInterval(() => {
					const got = existsSync(part) ? statSync(part).size / 2 ** 30 : 0;
					progress(`downloading ${m.name}: ${got.toFixed(2)} / ${m.sizeGb} GB`);
				}, 2000);
				// -C - resumes a previous partial download; -f fails on HTTP errors.
				const code = await new Promise<number>((resolve) => {
					const c = spawn("curl", ["-fL", "-C", "-", "-o", part, m.url], { stdio: ["ignore", "ignore", logFd] });
					this.download = c;
					const finish = (code: number) => {
						if (this.download === c) this.download = undefined;
						resolve(code);
					};
					c.once("error", () => finish(1));
					c.once("exit", (x) => finish(x ?? 1));
				});
				clearInterval(t);
				if (generation !== this.generation) return fail("setup cancelled");
				if (code !== 0) return fail("download failed");
				renameSync(part, modelPath(m));
			}
			if (generation !== this.generation) return fail("setup cancelled");
			progress(`loading ${m.name}…`);
			// -np 1: one slot gets the whole context; --jinja: chat template so thinking can be disabled.
			this.child = spawn(
				"llama-server",
				["-m", modelPath(m), "--alias", m.id, "--host", "127.0.0.1", "--port", new URL(baseUrl).port || "3000", "-c", "8192", "-np", "1", "-ngl", "999", "--jinja"],
				{ stdio: ["ignore", logFd, logFd] },
			);
			let exited = false;
			this.child.on("exit", () => (exited = true));
			for (let waited = 0; waited < 180_000; waited += 2000) {
				await new Promise((r) => setTimeout(r, 2000));
				if (generation !== this.generation) return fail("setup cancelled");
				if (exited) {
					const info = await inspectServer(baseUrl, 2000);
					if (generation !== this.generation) return fail("setup cancelled");
					if (info.ready && info.modelId === m.id) return undefined;
					if (onPortConflict && retries < 2 && info.listening && (info.modelId !== m.id || !info.ready)) {
						const nextUrl = await onPortConflict();
						if (generation !== this.generation) return fail("setup cancelled");
						progress(`port was claimed during startup; retrying at ${nextUrl}`);
						return this.start(m, nextUrl, progress, onPortConflict, retries + 1);
					}
					return fail("llama-server exited during startup");
				}
				const info = await inspectServer(baseUrl, 2000);
				if (generation !== this.generation) return fail("setup cancelled");
				if (info.ready && info.modelId === m.id) return undefined;
			}
			this.stop();
			return "llama-server did not become ready within 3 minutes";
		} finally {
			closeSync(logFd);
		}
	}

	stop(): void {
		this.generation++;
		this.download?.kill();
		this.download = undefined;
		this.child?.kill();
		this.child = undefined;
	}
}
