type TimeTree = { parent: TimeTree | null, n: number, ms: number, branches: Record<string, TimeTree> };

const rootTimeTree: TimeTree = { parent: null, n: 0, ms: 0, branches: {} };
let timeLeaf = rootTimeTree;
export function timed<T>(label: string, f: () => T): T {
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
		out = f();
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
