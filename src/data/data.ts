export function zipKeyedMapsTotal<I, K, V>(maps: Map<I, Map<K, V>>): Map<K, Map<I, V>> {
	if (maps.size === 0) {
		return new Map();
	}

	const smallestKeySet = [
		...[...maps.values()]
			.sort((a, b) => a.size - b.size)[0]
			.keys()
	];

	const out = new Map<K, Map<I, V>>();
	for (const key of smallestKeySet) {
		const here: Map<I, V> = new Map<I, V>();
		for (const [i, map] of maps) {
			if (map.has(key)) {
				here.set(i, map.get(key)!);
			}
		}
		if (here.size === maps.size) {
			out.set(key, here);
		}
	}
	return out;
}

export class Stabilizing<T> {
	constructor(
		private millis: number,
		private onStabilize: (t: T) => void,
	) { }

	private timer: null | number = null;
	private lastValue: null | T = null;
	update(value: T, millis: number = this.millis): void {
		if (this.lastValue === value) {
			return;
		}
		this.lastValue = value;

		if (this.timer !== null) {
			clearTimeout(this.timer);
		}

		if (millis <= 0) {
			this.onStabilize(this.lastValue!);
			this.timer = null;
		} else {
			this.timer = setTimeout(() => {
				this.onStabilize(this.lastValue!);
			}, millis);
		}
	}
}

export class Refreshing<A, B> {
	constructor(
		private effect: (t: A) => Promise<B>,
		private onResolve: (b: B, a: A) => void,
		private onError: (a: A, e: unknown) => void = () => { },
	) { }

	private lastInvocation: unknown = null;

	update(a: A): void {
		const invocation = Symbol();
		this.lastInvocation = invocation;
		const promise = this.effect(a);
		promise.then(resolved => {
			if (this.lastInvocation === invocation) {
				this.onResolve(resolved, a);
			}
		});
		promise.catch(error => {
			this.onError(a, error);
		});
	}
}
