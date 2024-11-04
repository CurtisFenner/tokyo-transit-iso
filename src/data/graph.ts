import { MinHeap } from "./heap";

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

export interface LabeledDistanceGraph<N, E> {
	neighbors(n: N): { edge: E, node: N, distance: number }[];
}

export function dijkstras<N, E, I>(
	sources: Map<N, { distance: number, initial: I }>,
	graph: LabeledDistanceGraph<N, E>
): Map<
	N,
	{ parent: null, distance: number, initial: I }
	| { parent: N, edge: E, distance: number }
> {
	const path = new Map<
		N,
		{ parent: null, distance: number, initial: I }
		| { parent: N, edge: E, distance: number }
	>();

	const queue = new MinHeap<N>((a, b) => {
		const da = path.get(a)!.distance;
		const db = path.get(b)!.distance;
		return da < db ? "<" : ">";
	});

	for (const [node, source] of sources) {
		path.set(node, {
			parent: null,
			distance: source.distance,
			initial: source.initial,
		});
		queue.push(node);
	}

	while (queue.size() > 0) {
		const top = queue.pop();
		const distance = path.get(top)!.distance;

		for (const connection of graph.neighbors(top)) {
			const neighborPath = path.get(connection.node);
			if (neighborPath === undefined || neighborPath.distance > distance + connection.distance) {
				path.set(connection.node, {
					parent: top,
					distance: distance + connection.distance,
					edge: connection.edge,
				});
				queue.push(connection.node);
			}
		}
	}

	return path;
}
