import * as maplibregl from "maplibre-gl";

export function watchClusters(
	map: maplibregl.Map,
	sourceID: string,
	options: {
		limit: number,
		debounceMs: number,
	},
	f: (clusters: Record<string, unknown>[][]) => void,
) {
	let stale = true;
	let waiting: unknown = false;

	function finishWaiting() {
		waiting = false;
		work();
	}

	async function work() {
		if (!stale) {
			return;
		}
		const me = {};
		if (waiting === false) {
			waiting = me;
		}
		stale = false;

		const source = map.getSource(sourceID) as maplibregl.GeoJSONSource;
		const clusterLeaves = [];
		const ps = [];
		for (const cluster of map.querySourceFeatures(sourceID)) {
			if (!cluster.properties.cluster) {
				clusterLeaves.push([cluster.properties]);
			} else {
				const leavesP = source.getClusterLeaves(
					cluster.properties.cluster_id,
					options.limit,
					0,
				);

				ps.push(leavesP);
			}
		}

		for (const chunk of await Promise.all(ps)) {
			clusterLeaves.push(chunk.map(x => x.properties || {}));
		}

		f(clusterLeaves);

		if (waiting === me) {
			setTimeout(finishWaiting, options.debounceMs);
		}
	}

	function markStale() {
		stale = true;
		if (!waiting) {
			work();
		}
	}

	markStale();

	map.on("zoomstart", markStale);
	map.on("zoom", markStale);
	map.on("zoomend", markStale);

	map.on("movestart", markStale);
	map.on("move", markStale);
	map.on("moveend", markStale);
}
