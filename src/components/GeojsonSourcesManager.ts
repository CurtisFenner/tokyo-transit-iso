export class GeojsonSourcesManager<T> {
	private dataset = new Map<string, GeoJSON.GeoJSON>();
	constructor(
		public map: maplibregl.Map,
		public generator: (t: T) => Promise<GeoJSON.Feature>,
	) {
	}

	createSource(
		id: string,
		geometryType: "MultiPolygon" | "MultiLineString" = "MultiPolygon",
		options: { maxzoom?: number } = {},
	): string {
		const sourceID = `isoline-source-${id}`;
		const blank: GeoJSON.GeoJSON = {
			type: "Feature",
			geometry: geometryType === "MultiPolygon" ? {
				type: geometryType,
				coordinates: [],
			} : {
				type: geometryType,
				coordinates: [],
			},
			properties: {},
		};
		this.dataset.set(id, blank);

		this.map.addSource(sourceID, {
			type: "geojson",
			lineMetrics: true,
			data: blank,
			...options.maxzoom !== undefined ? { maxzoom: options.maxzoom } : {},
		});
		return sourceID;
	}

	private updateSourceGeometry(
		id: string,
		data: GeoJSON.Feature,
	) {
		if (!this.dataset.has(id)) {
			throw new Error("id `" + id + "` not defined");
		}
		this.dataset.set(id, data.geometry);
		const sourceID = `isoline-source-${id}`;
		const source = this.map.getSource(sourceID) as maplibregl.GeoJSONSource;
		source.setData(data);
	}

	async recalculateSourceGeometry(id: string, t: T) {
		const lease = this.dataset.get(id);
		if (!lease) {
			throw new Error("id `" + id + "` not defined");
		}

		const newGeoJSON = await this.generator(t);

		if (this.dataset.get(id) === lease) {
			this.updateSourceGeometry(id, newGeoJSON);
		}
	}
}
