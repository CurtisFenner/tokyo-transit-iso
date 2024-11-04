import { earthGreatCircleDistanceKm } from "../geometry";

export function toTile(zoom: number, coordinate: Coordinate): {
	x: number, y: number,
	ix: number, iy: number,
} {
	const x3857 = coordinate.lon;
	const latRad = coordinate.lat * Math.PI / 180;
	const y3857 = Math.log(Math.tan(latRad) + 1 / Math.cos(latRad));
	const x = 0.5 + x3857 / 360;
	const y = 0.5 - y3857 / (2 * Math.PI);
	const n = 2 ** zoom;
	return {
		x: n * x,
		y: n * y,
		ix: Math.floor(n * x),
		iy: Math.floor(n * y),
	};
}

export class Spatial<T extends { coordinate: Coordinate }> {
	constructor(private zoom: number) { }
	private grid = new Map<string, T[]>();

	add(t: T) {
		const { ix, iy } = toTile(this.zoom, t.coordinate);
		const tileID = `${ix}/${iy}`;
		const tile = this.grid.get(tileID) || [];
		tile.push(t);
		this.grid.set(tileID, tile);
	}

	neighborhoodOf(query: Coordinate, radius = 1) {
		const { ix, iy } = toTile(this.zoom, query);
		const out: T[] = [];
		for (let u = -radius; u <= radius; u++) {
			for (let v = -radius; v <= radius; v++) {
				const neighbor = `${ix + u}/${iy + v}`;
				const grid = this.grid.get(neighbor);
				if (grid !== undefined) {
					out.push(...grid);
				}
			}
		}
		return out;
	}

	nearby(query: Coordinate, radiusKm: number): T[] {
		return this.neighborhoodOf(query).filter(x => earthGreatCircleDistanceKm(x.coordinate, query) < radiusKm);
	}
}

function shoelaceArea(polygon: Coordinate[]) {
	let area = 0;
	for (let i = 0; i < polygon.length; i++) {
		const j = (i + 1) % polygon.length;
		const w = polygon[j].lon - polygon[i].lon;
		const h = (polygon[j].lat + polygon[i].lat) / 2;
		area += w * h;
	}
	return area;
}

export function doesPolygonContainPoint(polygon: Coordinate[], point: Coordinate) {
	let count = 0;
	for (let i = 0; i < polygon.length; i++) {
		const a = polygon[i];
		const j = (i + 1) % polygon.length;
		const b = polygon[j];
		if (point.lon === a.lon) {
			continue;
		} else if (point.lon < Math.min(a.lon, b.lon) || Math.max(a.lon, b.lon) < point.lon) {
			continue;
		}

		const bx = b.lon - a.lon;
		const by = b.lat - a.lat;
		const dx = point.lon - a.lon;
		const dy = point.lat - a.lat;
		const iy = by * (dx / bx);
		if (iy < dy) {
			count += 1;
		}
	}
	return count % 2 === 1;
}

type RingTree = {
	polygon: Coordinate[],
	signedArea: number,
	children: RingTree[],
};

export function groupContainedRings(polygons: Coordinate[][]): RingTree[] {
	const stack: RingTree[] = [
		{ polygon: [], signedArea: -Infinity, children: [] },
	];

	const sortedSized = polygons
		.map(polygon => ({ polygon, signedArea: shoelaceArea(polygon) }))
		.sort((a, b) => Math.abs(b.signedArea) - Math.abs(a.signedArea));
	for (const next of sortedSized) {
		const query = next.polygon[0];
		let parent = stack[0];
		for (let k = stack.length - 1; k >= 0; k--) {
			if (doesPolygonContainPoint(stack[k].polygon, query)) {
				parent = stack[k];
				break;
			}
		}
		const tree = { polygon: next.polygon, signedArea: next.signedArea, children: [] };
		parent.children.push(tree);
		stack.push(tree);
	}
	return stack[0].children;
}

function toGeoJSONCoordinateLoop(polygon: Coordinate[], sign: number): [lon: number, lat: number][] {
	const array: [number, number][] = [...polygon, polygon[0]]
		.map(p => [p.lon, p.lat]);
	if (sign < 0) {
		return array.reverse();
	}
	return array;
}

export function geoJSONFromRingForest(forest: RingTree[]) {
	const positives = [...forest];
	const ringSets = [];
	for (const positive of positives) {
		const rings = [
			toGeoJSONCoordinateLoop(positive.polygon, -1 * positive.signedArea),
		];
		for (const child of positive.children) {
			const hole = toGeoJSONCoordinateLoop(child.polygon, 1 * child.signedArea);
			rings.push(hole);
			for (const grandchild of child.children) {
				positives.push(grandchild);
			}
		}
		ringSets.push(rings);
	}

	return {
		type: "Feature" as const,
		geometry: {
			type: "MultiPolygon" as const,
			coordinates: ringSets,
		},
		properties: {},
	};
}
