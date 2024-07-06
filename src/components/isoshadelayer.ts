export type MultiPolygonGeojsonData = {
	type: "Feature",
	geometry: {
		type: "MultiPolygon",
		coordinates: [number, number][][][],
	},
	properties: Record<string, number>,
};

export class IsoShadeLayer<T> {
	private dataset = new Map<string, MultiPolygonGeojsonData>();
	constructor(
		public map: maplibregl.Map,
		public generator: (t: T) => Promise<MultiPolygonGeojsonData>,
	) {
	}

	createShadeLayer(id: string) {
		const sourceID = `isoline-source-${id}`;
		const blank: MultiPolygonGeojsonData = {
			type: "Feature",
			geometry: {
				type: "MultiPolygon",
				coordinates: [],
			},
			properties: { "fill-opacity-prop": 0.9 },
		};
		this.dataset.set(id, blank);
		this.map.addSource(sourceID, {
			type: "geojson",
			lineMetrics: true,
			data: blank,
		});
		this.map.addLayer({
			id: `isolines-fill-${id}`,
			type: "fill",
			source: sourceID,
			paint: {
				"fill-color": "gray",
				"fill-opacity": ["get", "fill-opacity-prop"],
			},
		});
		this.map.addLayer({
			id: `isolines-line-${id}`,
			type: "line",
			source: sourceID,
			paint: {
				"line-color": "black",
				"line-width": 3,
			},
		});
	}

	updateShadeGeometry(
		id: string,
		data: MultiPolygonGeojsonData,
	) {
		if (!this.dataset.has(id)) {
			this.createShadeLayer(id);
		}
		this.dataset.set(id, data);
		this.refresh();
	}

	async updateShadeSource(id: string, t: T) {
		const lease = this.dataset.get(id);
		if (!lease) {
			this.createShadeLayer(id);
			this.updateShadeSource(id, t);
			return;
		}

		const newGeoJSON = await this.generator(t);

		if (this.dataset.get(id) === lease) {
			this.updateShadeGeometry(id, newGeoJSON);
		}
	}

	deleteShadeLayer(id: string) {
		if (!this.dataset.has(id)) {
			return;
		}
		this.dataset.delete(id);
		this.map.removeLayer(`isolines-fill-${id}`);
		this.map.removeLayer(`isolines-line-${id}`);
		this.map.removeSource(`isoline-source-${id}`);
		this.refresh();
	}

	refresh(): void {
		const COMBINED_OPACITY = 0.705;
		const COMBINED_TRANSPARENCY = 1 - COMBINED_OPACITY;
		const layerTransparency = Math.pow(COMBINED_TRANSPARENCY, 1 / Math.max(1, this.dataset.size));
		const layerOpacity = 1 - layerTransparency;

		for (const [clientSourceID, data] of this.dataset) {
			const sourceID = `isoline-source-${clientSourceID}`;
			const source = this.map.getSource(sourceID) as maplibregl.GeoJSONSource;
			source.setData({
				...data,
				properties: {
					...data.properties,
					"fill-opacity-prop": layerOpacity,
				},
			});
		}
	}
}
