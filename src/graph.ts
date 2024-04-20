export interface SimpleGraph<N> {
	neighbors(node: N): N[];
}

export function depthFirstSearch<N>(graph: SimpleGraph<N>, source: N): Map<N, N> {
	const out = new Map<N, N>();
	const seen = new Map<N, N>();
	seen.set(source, source);
	const stack = [source];
	while (stack.length !== 0) {
		const top = stack.pop()!;
		out.set(top, seen.get(top)!);
		for (const neighbor of graph.neighbors(top)) {
			if (seen.has(neighbor)) {
				continue;
			}
			seen.set(neighbor, top);
			stack.push(neighbor);
		}
	}

	return out;
}

export function components<N>(graph: SimpleGraph<N>, all: Iterable<N>): N[][] {
	const components: N[][] = [];
	const seen = new Set<N>();
	for (const entrypoint of all) {
		if (seen.has(entrypoint)) {
			continue;
		}
		const search = depthFirstSearch(graph, entrypoint);
		components.push([...search.keys()]);
		for (const key of search.keys()) {
			seen.add(key);
		}
	}

	return components;
}
