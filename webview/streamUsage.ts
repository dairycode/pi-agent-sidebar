import { objectValue } from "../shared/jsonValues.js";
import type { PiStats } from "../shared/protocol.js";

/**
 * 流式期间的实时 token 用量。
 *
 * pi 的 `message_update` 事件携带当次 LLM 调用（一条 assistant 回复）的实时累计
 * usage，而 `get_session_stats` 的 snapshot 只在回复结束后刷新。把「已结束调用」
 * 与「在飞调用」的用量叠加在最近一次 snapshot 之上，footer 就能在流式中实时跳动；
 * snapshot 一到即为权威值，这些状态随之归零。
 */
export interface UsageParts {
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
	cost: number;
}

export function zeroUsageParts(): UsageParts {
	return {
		tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		cost: 0,
	};
}

export function isEmptyUsageParts(usage: UsageParts): boolean {
	return (
		usage.cost === 0 &&
		usage.tokens.input === 0 &&
		usage.tokens.output === 0 &&
		usage.tokens.cacheRead === 0 &&
		usage.tokens.cacheWrite === 0
	);
}

/** 与 pi 的 `calculateContextTokens` 同口径：一次调用的全部 token。 */
export function usagePartsTotal(usage: UsageParts): number {
	return (
		usage.tokens.input +
		usage.tokens.output +
		usage.tokens.cacheRead +
		usage.tokens.cacheWrite
	);
}

export function addUsageParts(base: UsageParts, extra: UsageParts): UsageParts {
	return {
		tokens: {
			input: base.tokens.input + extra.tokens.input,
			output: base.tokens.output + extra.tokens.output,
			cacheRead: base.tokens.cacheRead + extra.tokens.cacheRead,
			cacheWrite: base.tokens.cacheWrite + extra.tokens.cacheWrite,
		},
		cost: base.cost + extra.cost,
	};
}

/**
 * 解析 RPC 事件里的 pi `Usage` 对象（message_update.usage / message.usage）。
 * 结构不符时返回 undefined，调用方沿用已有值，而不是把 footer 打回零。
 */
export function parseUsageParts(value: unknown): UsageParts | undefined {
	const usage = objectValue(value);
	const readPart = (
		key: "input" | "output" | "cacheRead" | "cacheWrite",
	): number => {
		const part = usage[key];
		return typeof part === "number" && Number.isFinite(part) ? part : NaN;
	};
	const input = readPart("input");
	const output = readPart("output");
	const cacheRead = readPart("cacheRead");
	const cacheWrite = readPart("cacheWrite");
	if (
		!Number.isFinite(input) ||
		!Number.isFinite(output) ||
		!Number.isFinite(cacheRead) ||
		!Number.isFinite(cacheWrite)
	)
		return undefined;
	const costRecord = objectValue(usage.cost);
	const cost =
		typeof costRecord.total === "number" && Number.isFinite(costRecord.total)
			? costRecord.total
			: 0;
	return { tokens: { input, output, cacheRead, cacheWrite }, cost };
}

/**
 * 流式用量状态机：跟随 pi 的事件流累积，并在 snapshot 之上合成展示值。
 *
 * 每个方法对应一个事件，返回是否有变化（调用方据此决定是否重绘 footer）。
 */
export class StreamingUsageTracker {
	/** 已结束调用的累计用量，叠加在 snapshot 之上。 */
	private finished = zeroUsageParts();
	/** 在飞调用的实时用量。 */
	private active: UsageParts | undefined;
	/**
	 * 最近一次被采信的调用用量，用于 context。
	 *
	 * context 口径是「最新一次调用」而非累计：pi 取最近一条有效 assistant usage
	 * （跳过 aborted/error 与全零）。工具执行期间没有新的 usage，此时沿用上一次
	 * 调用的值，与 pi 的 snapshot 口径一致。
	 */
	private latestAccepted: UsageParts | undefined;

	public reset(): void {
		this.finished = zeroUsageParts();
		this.active = undefined;
		this.latestAccepted = undefined;
	}

	/** 新一轮 agent 运行开始：从最近一次 snapshot 之上重新累计。 */
	public startAgentRun(): void {
		this.reset();
	}

	/** 新一轮 LLM 调用开始：在飞用量从零累计，上一轮已在 commitCall 提交。 */
	public beginCall(): void {
		this.active = undefined;
	}

	/** message_update：覆盖式写入在飞用量（provider 报的是累计值，不是增量）。 */
	public applyUpdate(value: unknown): boolean {
		const usage = parseUsageParts(value);
		if (!usage) return false;
		this.active = usage;
		return true;
	}

	/** assistant 的 message_end：最终用量并入累计，有效时更新 context 基准。 */
	public commitCall(value: unknown, stopReason: string): boolean {
		const usage = parseUsageParts(value);
		if (!usage) return false;
		this.finished = addUsageParts(this.finished, usage);
		this.active = undefined;
		// pi 统计 session 总量时不看 stopReason，但 context 只认有效调用。
		if (
			stopReason !== "aborted" &&
			stopReason !== "error" &&
			usagePartsTotal(usage) > 0
		) {
			this.latestAccepted = usage;
		}
		return true;
	}

	/** toolResult 的 message_end：工具用量只进 session 累计，不做 context 基准。 */
	public addToolUsage(value: unknown): boolean {
		const usage = parseUsageParts(value);
		if (!usage) return false;
		this.finished = addUsageParts(this.finished, usage);
		return true;
	}

	public hasLiveUsage(): boolean {
		return this.active !== undefined || !isEmptyUsageParts(this.finished);
	}

	/** snapshot 统计 + 流式实时增量，用于 footer 实时显示。 */
	public displayStats(stats: PiStats | undefined): PiStats | undefined {
		if (!stats || !this.hasLiveUsage()) return stats;
		const combined = addUsageParts(
			addUsageParts(zeroUsageParts(), this.finished),
			this.active ?? zeroUsageParts(),
		);
		const baseTokens = stats.tokens;
		const input = (baseTokens?.input ?? 0) + combined.tokens.input;
		const output = (baseTokens?.output ?? 0) + combined.tokens.output;
		const cacheRead = (baseTokens?.cacheRead ?? 0) + combined.tokens.cacheRead;
		const cacheWrite = (baseTokens?.cacheWrite ?? 0) + combined.tokens.cacheWrite;
		return {
			...stats,
			contextUsage: this.liveContextUsage(stats) ?? stats.contextUsage,
			tokens: {
				input,
				output,
				cacheRead,
				cacheWrite,
				total: input + output + cacheRead + cacheWrite,
			},
			cost: (typeof stats.cost === "number" ? stats.cost : 0) + combined.cost,
		};
	}

	/**
	 * 流式期间的 context 占用：取最近一次被采信的调用总 token，窗口沿用 snapshot。
	 * 全零 usage 不采信，避免 provider 未报数时把 context 显示成 0%。
	 *
	 * pi 自己会在最后一次 usage 之上叠加其后消息的估算值（如尚未送出的工具结果），
	 * 这里不复制那套估算：在飞调用的 usage 已包含完整 prompt，数值是精确的；
	 * 仅在两轮调用之间会略低于 pi 的估算值，下一轮 usage 到达即对齐。
	 */
	private liveContextUsage(stats: PiStats): PiStats["contextUsage"] {
		const contextWindow = stats.contextUsage?.contextWindow;
		if (typeof contextWindow !== "number" || contextWindow <= 0) return undefined;
		const usage = [this.active, this.latestAccepted].find(
			(candidate) => candidate !== undefined && usagePartsTotal(candidate) > 0,
		);
		if (!usage) return undefined;
		const tokens = usagePartsTotal(usage);
		return { tokens, contextWindow, percent: (tokens / contextWindow) * 100 };
	}
}
