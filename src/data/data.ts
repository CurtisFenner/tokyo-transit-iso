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
