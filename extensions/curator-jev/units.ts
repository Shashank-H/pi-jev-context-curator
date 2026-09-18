/**
 * Message introspection and grouping into curation units.
 *
 * A "unit" is the atomic thing Jev judges: a plain message on its own, or an
 * assistant tool-call message together with the tool results that follow it.
 * Grouping this way guarantees curation never orphans a tool result.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";

export interface Unit {
	/** Indexes into the original message list. */
	messageIndexes: number[];
	label: string;
	text: string;
	/** Units that must never be dropped (system messages; set for the latest unit by the caller). */
	alwaysKeep: boolean;
}

type Role = string | undefined;

function roleOf(m: AgentMessage): Role {
	return (m as { role?: string }).role;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((b) => {
				if (typeof b === "string") return b;
				if (b && typeof b === "object") {
					const block = b as { type?: string; text?: string; thinking?: string };
					if (block.type === "text" && typeof block.text === "string") return block.text;
					if (block.type === "thinking" && typeof block.thinking === "string")
						return `[thinking] ${block.thinking}`;
				}
				return "";
			})
			.filter(Boolean)
			.join("\n");
	}
	return "";
}

function toolCallsOf(m: AgentMessage): { id: string; name: string }[] {
	const content = (m as { content?: unknown }).content;
	if (!Array.isArray(content)) return [];
	return content
		.filter(
			(b): b is { type: "toolCall"; id: string; name: string } =>
				!!b && typeof b === "object" && (b as { type?: string }).type === "toolCall",
		)
		.map((b) => ({ id: b.id, name: b.name }));
}

/** Short human-readable description of one message, used as Jev evidence. */
export function describeMessage(m: AgentMessage): { label: string; text: string } {
	const role = roleOf(m) ?? "unknown";
	if (role === "system") {
		const msg = m as { content?: unknown; sections?: Record<string, string | null> };
		const sections = msg.sections
			? `\n[prompt sections: ${Object.keys(msg.sections).join(", ")}]`
			: "";
		return { label: "system", text: textOf(msg.content) + sections };
	}
	if (role === "user") {
		return { label: "user", text: textOf((m as { content?: unknown }).content) };
	}
	if (role === "assistant") {
		const calls = toolCallsOf(m);
		const callSummary = calls.length
			? `\n[tool calls: ${calls.map((c) => c.name).join(", ")}]`
			: "";
		return { label: "assistant", text: textOf((m as { content?: unknown }).content) + callSummary };
	}
	if (role === "toolResult") {
		const msg = m as { toolName?: string; isError?: boolean; content?: unknown };
		const prefix = `[tool result: ${msg.toolName ?? "unknown"}${msg.isError ? " (errored)" : ""}]`;
		return { label: `toolResult:${msg.toolName ?? "?"}`, text: `${prefix}\n${textOf(msg.content)}` };
	}
	return { label: role, text: textOf((m as { content?: unknown }).content) || JSON.stringify(m).slice(0, 500) };
}

export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function makeUnit(messages: AgentMessage[], indexes: number[]): Unit {
	const described = indexes.map((i) => describeMessage(messages[i]));
	const label = described.map((d) => d.label).join("+");
	const text = described.map((d) => d.text).join("\n---\n");
	const hasSystem = indexes.some((i) => roleOf(messages[i]) === "system");
	return { messageIndexes: indexes, label, text, alwaysKeep: hasSystem };
}

export function groupIntoUnits(messages: AgentMessage[]): Unit[] {
	const units: Unit[] = [];
	let pending: number[] | null = null;

	const flush = () => {
		if (pending && pending.length > 0) units.push(makeUnit(messages, pending));
		pending = null;
	};

	messages.forEach((m, i) => {
		const role = roleOf(m);
		if (pending) {
			if (role === "toolResult") {
				pending.push(i);
				return;
			}
			flush();
		}
		if (role === "assistant" && toolCallsOf(m).length > 0) {
			pending = [i];
			return;
		}
		units.push(makeUnit(messages, [i]));
	});
	flush();
	return units;
}
