import { LocalCoordinate, LocalLine, LocalPlane, earthGreatCircleDistanceKm } from "./geometry";

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

export class PolarIndex {
	private buckets: Set<LocalLine>[] = [];
	private origin = { xKm: 0, yKm: 0 };

	private bucketIndex(theta: number): number {
		const tau = Math.PI * 2
		const p = ((theta % (tau) + tau) % tau) / tau;
		return Math.floor(p * this.buckets.length);
	}

	private bucketByAngle(theta: number) {
		return this.buckets[this.bucketIndex(theta)];
	}

	castTo(plane: LocalPlane, point: LocalCoordinate): LocalCoordinate {
		const angle = Math.atan2(point.yKm, point.xKm);
		let best = point;
		let bestDistance = plane.distanceKm(this.origin, point);
		for (const segment of this.bucketByAngle(angle)) {
			const hit = plane.segmentIntersection({ a: this.origin, b: point }, segment);
			if (!hit) {
				continue;
			}
			const d = plane.distanceKm(this.origin, hit);
			if (d < bestDistance) {
				bestDistance = d;
				best = hit;
			}
		}
		return best;
	}

	constructor(segments: LocalLine[]) {
		for (let i = 0; i < 31; i++) {
			this.buckets.push(new Set());
		}

		const step = Math.PI * 2 / this.buckets.length;

		for (const segment of segments) {
			const ta = Math.atan2(segment.a.yKm, segment.a.xKm);
			const tb = Math.atan2(segment.b.yKm, segment.b.xKm);

			let lowTheta = Math.min(ta, tb);
			let highTheta = Math.max(ta, tb);

			if (highTheta - lowTheta > Math.PI) {
				const oldLow = lowTheta;
				const oldHigh = highTheta;

				lowTheta = oldHigh;
				highTheta = oldLow + Math.PI * 2;
			}

			this.bucketByAngle(lowTheta).add(segment);
			for (let t = lowTheta + step / 2; t < highTheta; t += step) {
				this.bucketByAngle(t).add(segment);
			}
			this.bucketByAngle(highTheta).add(segment);
		}
	}
}

function printCoordinate(a: LocalCoordinate) {
	return `[${a.xKm}, ${a.yKm}]`;
}

export function assertNear(actual: LocalCoordinate, expected: LocalCoordinate) {
	const distance = LocalPlane.nearPoint({ lat: 0, lon: 0 }).distanceKm(actual, expected);
	if (distance > 1e-2) {
		throw new Error(
			`expected ${printCoordinate(actual)}`
			+ ` to be near to ${printCoordinate(expected)}`
			+ ` but they were ${distance} apart`
		);
	}
}

{
	const plane = LocalPlane.nearPoint({ lat: 0, lon: 0 });

	const index = new PolarIndex([
		{
			a: { xKm: 5, yKm: -5 },
			b: { xKm: 5, yKm: 5 },
		},
		{
			a: { xKm: -3, yKm: -3 },
			b: { xKm: -3, yKm: 3 },
		},
	]);

	const hitRight = index.castTo(plane, { xKm: 10, yKm: 0 });
	assertNear(hitRight, { xKm: 5, yKm: 0 });

	const hitLeft = index.castTo(plane, { xKm: -10, yKm: 0 });
	assertNear(hitLeft, { xKm: -3, yKm: 0 });
}
