import * as maplibregl from "maplibre-gl";
import { watchClusters } from "../map-helper";

export class ClusteredLabels<T> {
	private data: {
		data: T,
		coordinate: Coordinate,
		minZoom: number,
	}[];
	private markers: maplibregl.Marker[];

	private nullMarker: maplibregl.Marker;

	constructor(
		map: maplibregl.Map,
		data: {
			data: T,
			minZoom: number,
			coordinate: Coordinate,
			priority: number,
		}[],
		options: {
			clusterRadius: number,
			debounceMs?: number,
			makeMarker: (d: T) => maplibregl.Marker,
		},
	) {
		this.data = data.slice()
			.map((x, i) => ({ x, i }))
			.sort((a, b) => a.x.priority === b.x.priority
				? a.i - b.i
				: b.x.priority - a.x.priority)
			.map(x => x.x);

		const features: {
			type: "Feature",
			properties: object,
			geometry: {
				type: "Point",
				coordinates: [number, number],
			},
		}[] = this.data.map((datum, index) => {
			return {
				type: "Feature",
				properties: { index },
				geometry: {
					type: "Point",
					coordinates: [datum.coordinate.lon, datum.coordinate.lat],
				},
			};
		});

		const sourceID = "ClusteredLabels-" + Math.random();
		map.addSource(sourceID, {
			type: "geojson",
			data: {
				type: "FeatureCollection",
				features,
			},
			cluster: true,
			clusterRadius: options.clusterRadius,
		});

		// Add an invisible layer that uses the source to force it to be
		// computed.
		const layerID = sourceID + "-invisible-layer";
		map.addLayer({
			id: layerID,
			type: "circle",
			source: sourceID,
			paint: { "circle-radius": 0, "circle-opacity": 0 },
		});

		this.markers = this.data.map(datum => {
			const marker = options.makeMarker(datum.data)
				.setLngLat(datum.coordinate);
			marker.addTo(map);
			marker.remove();
			return marker;
		});

		this.nullMarker = new maplibregl.Marker({
			opacity: "0%",
		}).setLngLat([0, 0]).addTo(map);

		let previouslyDisplayedMarkers = new Set<maplibregl.Marker>();

		watchClusters(map, sourceID, {
			limit: 150,
			debounceMs: options.debounceMs || 150,
		}, clusters => {
			const zoom = map.getZoom();
			const displayedMarkers = new Set(clusters.map(cluster => {
				const ks: number[] = cluster.map(x => (x as any).index);
				return Math.min(...ks);
			}).filter(index => {
				return zoom >= this.data[index].minZoom;
			}).map(index => {
				return this.markers[index];
			}));

			for (const x of previouslyDisplayedMarkers) {
				if (!displayedMarkers.has(x)) {
					x.remove();
				}
			}

			for (const x of displayedMarkers) {
				if (!previouslyDisplayedMarkers.has(x)) {
					x.addTo(map);
					const line = this.nullMarker.getElement();
					const element = x.getElement();
					if (element.parentElement !== line.parentElement) {
						console.warn("unexpected parenting");
					}
					element.parentElement?.insertBefore(element, line);
				}
			}

			previouslyDisplayedMarkers = displayedMarkers;
		});
	}
}
