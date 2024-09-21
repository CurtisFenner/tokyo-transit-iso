type TimeTree = { parent: TimeTree | null, n: number, ms: number, branches: Record<string, TimeTree> };

const rootTimeTree: TimeTree = { parent: null, n: 0, ms: 0, branches: {} };
let timeLeaf = rootTimeTree;
export async function timed<T>(label: string, f: () => Promise<T>): Promise<T> {
	const branch = timeLeaf.branches[label] || {
		parent: timeLeaf,
		n: 0,
		ms: 0,
		branches: {},
	};
	timeLeaf.branches[label] = branch;

	let out: T;
	const beforeMs = performance.now();
	try {
		timeLeaf = branch;
		out = await f();
	} catch (e) {
		throw e;
	} finally {
		const afterMs = performance.now();
		branch.n += 1;
		branch.ms += afterMs - beforeMs;
		timeLeaf = branch.parent!;
	}
	return out;
}

export function printTimeTree(tree: TimeTree = rootTimeTree, label: string = "[root]"): string[] {
	return [
		"+" + tree.ms.toFixed(0).padStart(6, " ") + " ms: " + label + " (x " + tree.n + ")",
		...Object.entries(tree.branches).flatMap(([label, subtree]) => {
			return printTimeTree(subtree, label).map(x => "|" + " ".repeat(7) + x);
		}),
	];
}

export function sleep(ms: number): Promise<number> {
	const before = performance.now();
	return new Promise(resolve => {
		setTimeout(() => {
			const after = performance.now();
			resolve(after - before);
		}, ms);
	});
}

export class Timeline {
	private data = new Map<symbol, {
		message: string,
		startMs: number,
		endMs: null | number,
		endMessage: null | string,
	}>();

	start(message: string, startMs = performance.now()): symbol {
		const x = Symbol("stopwatch");
		this.data.set(x, {
			message,
			startMs,
			endMs: null,
			endMessage: null,
		});
		return x;
	}

	finish(x: symbol, endMessage: null | string): void {
		const y = this.data.get(x);
		if (!y) throw new Error("unknown symbol");
		if (y.endMs) throw new Error("already finished");

		y.endMs = performance.now();
		y.endMessage = endMessage;
	}

	entries(): {
		message: string,
		startMs: number,
		endMs: null | number,
		endMessage: null | string,
	}[] {
		return [... this.data.values()].map(x => ({ ...x }));
	}
}
