export const EARTH_RADIUS_KM = 6378.1;
export const STANDARD_WALKING_SPEED_KPH = 4.5;
export const WALK_MAX_MIN = 30;
export const WALK_MAX_KM = WALK_MAX_MIN * STANDARD_WALKING_SPEED_KPH * 60;

export function toSpherical(coordinate: Coordinate) {
	const latRad = Math.PI * 2 * coordinate.lat / 360;
	const lonRad = Math.PI * 2 * coordinate.lon / 360;
	return {
		x: Math.cos(lonRad) * Math.cos(latRad),
		y: Math.sin(lonRad) * Math.cos(latRad),
		z: Math.sin(latRad),
	};
}

export function earthGreatCircleDistanceKm(a: Coordinate, b: Coordinate) {
	const va = toSpherical(a);
	const vb = toSpherical(b);
	const dot = va.x * vb.x + va.y * vb.y + va.z * vb.z;
	const angleRad = Math.acos(dot);
	return angleRad * EARTH_RADIUS_KM;
}

// export type LocalCoordinate = { xKm: number, yKm: number };
export type LocalCoordinate = number & { __brand: "PackedLocal" };
export type LocalLine = { a: LocalCoordinate, b: LocalCoordinate };

const KM_PER_INT = 1e-4;
const PACK_HIGH = 2 ** 12;
function packLocalComponent(x: number): number {
	const p = (x + PACK_HIGH) / (PACK_HIGH * 2);
	const i = Math.round(p * 2 ** 24);
	return i;
}
function packLocal(x: number, y: number): LocalCoordinate {
	const ix = packLocalComponent(x);
	const iy = packLocalComponent(y);
	return (ix * (2 ** 24)) + iy as LocalCoordinate;
}

function unpackLocalXkm(v: LocalCoordinate): number {
	const ix = Math.floor(v / (2 ** 24));
	return (ix / (2 ** 24)) * PACK_HIGH * 2 - PACK_HIGH;
}

function unpackLocalYkm(v: LocalCoordinate): number {
	const iy = v % (2 ** 24);
	return (iy / (2 ** 24)) * PACK_HIGH * 2 - PACK_HIGH;
}

export class LocalPlane {
	private constructor(
		private readonly lonDegPerKm: number,
		private readonly latDegPerKm: number,
		private readonly origin: Coordinate,
	) { }

	static nearPoint(coordinate: Coordinate): LocalPlane {
		const latDegPerKm = 360 / (EARTH_RADIUS_KM * 2 * Math.PI);
		const lonDegPerKm = latDegPerKm / Math.cos(coordinate.lat * Math.PI / 180);
		return new LocalPlane(lonDegPerKm, latDegPerKm, coordinate);
	}

	toLocal(coordinate: Coordinate): LocalCoordinate {
		return packLocal(
			(coordinate.lon - this.origin.lon) / this.lonDegPerKm,
			(coordinate.lat - this.origin.lat) / this.latDegPerKm,
		);
	}

	toGlobe(local: LocalCoordinate): Coordinate {
		const xKm = unpackLocalXkm(local);
		const yKm = unpackLocalYkm(local);
		return {
			lon: xKm * this.lonDegPerKm + this.origin.lon,
			lat: yKm * this.latDegPerKm + this.origin.lat,
		};
	}

	subtract(a: LocalCoordinate, b: LocalCoordinate): LocalCoordinate {
		// Assumes no overflow
		return a - b as LocalCoordinate;
	}

	add(a: LocalCoordinate, b: LocalCoordinate): LocalCoordinate {
		// Assumes no overflow
		return a + b as LocalCoordinate;
	}

	angleOf(v: LocalCoordinate): number {
		const xKm = unpackLocalXkm(v);
		const yKm = unpackLocalYkm(v);
		return Math.atan2(yKm, xKm);
	}

	polar(radiusKm: number, angle: number): LocalCoordinate {
		return packLocal(
			radiusKm * Math.cos(angle),
			radiusKm * Math.sin(angle),
		);
	}

	distanceKm(a: LocalCoordinate, b: LocalCoordinate) {
		const delta = a - b as LocalCoordinate;
		const dx = unpackLocalXkm(delta);
		const dy = unpackLocalYkm(delta);
		return Math.sqrt(dx ** 2 + dy ** 2);
	}

	directionTo(a: LocalCoordinate, b: LocalCoordinate): LocalCoordinate {
		const length = this.distanceKm(a, b);
		const delta = a - b as LocalCoordinate;
		const dx = unpackLocalXkm(delta) / length;
		const dy = unpackLocalYkm(delta) / length;
		return packLocal(dx, dy);
	}

	lineIntersection(u: LocalLine, v: LocalLine): LocalCoordinate | null {
		const uax = unpackLocalXkm(u.a);
		const uay = unpackLocalYkm(u.a);
		const ubx = unpackLocalXkm(u.b);
		const uby = unpackLocalYkm(u.b);

		const vax = unpackLocalXkm(v.a);
		const vay = unpackLocalYkm(v.a);
		const vbx = unpackLocalXkm(v.b);
		const vby = unpackLocalYkm(v.b);

		const udx = uax - ubx;
		const udy = uay - uby;
		const vdx = vax - vbx;
		const vdy = vay - vby;

		const denominator = udx * vdy - udy * vdx;
		if (denominator === 0) {
			return null;
		}

		const cross1 = uax * uby - uay * ubx;
		const cross2 = vax * vby - vay * vbx;

		const intersectX = (cross1 * vdx - udx * cross2) / denominator;
		const intersectY = (cross1 * vdy - udy * cross2) / denominator;

		return packLocal(intersectX, intersectY);
	}

	segmentIntersection(
		u: LocalLine,
		v: LocalLine,
		epsilon = 1e-2,
	): LocalCoordinate | null {
		const intersection = this.lineIntersection(u, v);
		if (intersection === null) {
			return null;
		}

		const onU = this.liesWithinBoundingBox(intersection, u, epsilon);
		const onV = this.liesWithinBoundingBox(intersection, v, epsilon);
		if (onU && onV) {
			return intersection;
		}
		return null;
	}

	pathIntersections(u: LocalCoordinate[], v: LocalCoordinate[]): LocalCoordinate[] {
		const out = [];
		for (let ui = 0; ui + 1 < u.length; ui++) {
			for (let vi = 0; vi + 1 < v.length; vi++) {
				const su: LocalLine = { a: u[ui], b: u[ui + 1] };
				const sv: LocalLine = { a: v[vi], b: v[vi + 1] };
				const intersection = this.segmentIntersection(su, sv);
				if (intersection !== null) {
					out.push(intersection);
				}
			}
		}

		return out;
	}

	liesWithinBoundingBox(
		point: LocalCoordinate,
		segment: LocalLine,
		epsilon = 1e-2,
	) {
		const ax = unpackLocalXkm(segment.a);
		const ay = unpackLocalYkm(segment.a);
		const bx = unpackLocalXkm(segment.b);
		const by = unpackLocalYkm(segment.b);
		const lowX = Math.min(ax, bx) - epsilon;
		const highX = Math.max(ax, bx) + epsilon;
		const lowY = Math.min(ay, by) - epsilon;
		const highY = Math.max(ay, by) + epsilon;

		const x = unpackLocalXkm(point);
		const y = unpackLocalYkm(point);
		return lowX <= x && x <= highX && lowY <= y && y <= highY;
	}

	lineCircleIntersection(line: LocalLine, center: LocalCoordinate, radius: number): LocalCoordinate[] {
		const delta = line.b - line.a as LocalCoordinate;
		const ax = unpackLocalXkm(line.a);
		const ay = unpackLocalYkm(line.a);
		const bx = unpackLocalXkm(line.b);
		const by = unpackLocalYkm(line.b);

		const dx = unpackLocalXkm(delta);
		const dy = unpackLocalYkm(delta);
		const drSquared = dx * dx + dy * dy;
		const determinant = ax * by - bx * ay;
		const discriminant = radius * radius * drSquared - determinant * determinant;

		if (discriminant < 0) return [];

		const signDy = dy < 0 ? -1 : 1;
		const sqrtDiscriminant = Math.sqrt(discriminant);

		const intersectX1 = (determinant * dy + signDy * dx * sqrtDiscriminant) / drSquared;
		const intersectY1 = (-determinant * dx + Math.abs(dy) * sqrtDiscriminant) / drSquared;

		const intersectX2 = (determinant * dy - signDy * dx * sqrtDiscriminant) / drSquared;
		const intersectY2 = (-determinant * dx - Math.abs(dy) * sqrtDiscriminant) / drSquared;

		return [
			packLocal(intersectX1, intersectY1) + center as LocalCoordinate,
			packLocal(intersectX2, intersectY2) + center as LocalCoordinate,
		];
	}
}

export type GeoCircle = {
	coordinate: Coordinate,
	radiusKm: number,
};

export function geoMidpoint(a: Coordinate, b: Coordinate) {
	return {
		lat: (a.lat + b.lat) / 2,
		lon: (a.lon + b.lon) / 2,
	};
}

export function pathCircleIntersection(plane: LocalPlane, path: LocalCoordinate[], center: LocalCoordinate, radius: number): LocalCoordinate[] {
	const out: LocalCoordinate[] = [];
	for (let i = 0; i + 1 < path.length; i++) {
		const segment = { a: path[i], b: path[i + 1] };
		out.push(...plane.lineCircleIntersection(segment, center, radius));
	}
	return out;
}

function assertIsNear(actual: number, expected: number, message = "", epsilon = 1e-3): number {
	if (Math.abs(actual - expected) < epsilon) {
		return actual;
	} else {
		throw new Error(`expected ${message ? message + " " : ""}${actual} to be within ${epsilon} of ${expected}`);
	}
}

{
	const lineU: LocalLine = {
		a: packLocal(13, 8 * 13 - 7),
		b: packLocal(17, 8 * 17 - 7),
	};
	assertIsNear(unpackLocalXkm(lineU.a), 13, "a.x");
	assertIsNear(unpackLocalYkm(lineU.a), 8 * 13 - 7, "a.y");

	const lineV: LocalLine = {
		a: packLocal(31, -3 * 31 + 5),
		b: packLocal(37, -3 * 37 + 5),
	};

	const plane = LocalPlane.nearPoint({ lat: 0, lon: 0 });

	const actual = plane.lineIntersection(lineU, lineV);
	if (!actual) throw new Error("expected localLineIntersection to return");
	assertIsNear(unpackLocalXkm(actual), 12 / 11, "line-line-intersection.x");
	assertIsNear(unpackLocalYkm(actual), 19 / 11, "line-line-intersection.y");
}

export function geocircleIntersections(a: GeoCircle, b: GeoCircle): Coordinate[] {
	const distortion = LocalPlane.nearPoint(geoMidpoint(a.coordinate, b.coordinate));

	const distanceKm = earthGreatCircleDistanceKm(a.coordinate, b.coordinate);
	if (distanceKm > a.radiusKm + b.radiusKm || distanceKm < 1e-5) {
		return [];
	}
	const localA = distortion.toLocal(a.coordinate);
	const localB = distortion.toLocal(b.coordinate);
	const d = distortion.distanceKm(localA, localB);
	if (d >= a.radiusKm + b.radiusKm || d < 1e-5) {
		return [];
	}

	const parallel = (a.radiusKm ** 2 - b.radiusKm ** 2 + d ** 2) / (2 * d);
	const ortho = Math.sqrt(a.radiusKm ** 2 - parallel ** 2);

	const direction = distortion.directionTo(localA, localB);
	const dx = unpackLocalXkm(direction);
	const dy = unpackLocalYkm(direction);

	const localLeft = packLocal(
		dx * parallel - dy * ortho,
		dy * parallel + dx * ortho,
	);
	const localRight = packLocal(
		dx * parallel + dy * ortho,
		dy * parallel - dx * ortho,
	);

	return [
		distortion.toGlobe(localA + localLeft as LocalCoordinate),
		distortion.toGlobe(localA + localRight as LocalCoordinate),
	];
}

export function growingHyperbolas(
	a: GeoCircle,
	aInitialKm: number,
	b: GeoCircle,
	bInitialKm: number,
): null | Coordinate[] {
	if (aInitialKm > 0) throw Error();
	if (bInitialKm > 0) throw Error();

	const distortion = LocalPlane.nearPoint(geoMidpoint(a.coordinate, b.coordinate));

	const geodesicDistanceKm = earthGreatCircleDistanceKm(a.coordinate, b.coordinate);
	if (geodesicDistanceKm > a.radiusKm + b.radiusKm || geodesicDistanceKm < 1e-5) {
		return null;
	}
	const localA = distortion.toLocal(a.coordinate);
	const localB = distortion.toLocal(b.coordinate);

	const localDistance = distortion.distanceKm(localA, localB);

	if (localDistance <= 1e-3) {
		return null;
	}

	// a_i + t + b_i + t >= d
	// t >= (d - a_i - b_i) /2
	const startTime = (localDistance - aInitialKm - bInitialKm) / 2;
	const endTime = Math.min(
		a.radiusKm - aInitialKm,
		b.radiusKm - bInitialKm,
	);

	if (startTime >= endTime) {
		return null;
	}

	const resolution = 4;
	const left: Coordinate[] = [];
	const right: Coordinate[] = [];

	const localDirection: LocalCoordinate = distortion.directionTo(localA, localB);

	const localKiss: LocalCoordinate = localA + packLocal(
		(aInitialKm + startTime) * unpackLocalXkm(localDirection),
		(aInitialKm + startTime) * unpackLocalYkm(localDirection),
	) as LocalCoordinate;
	const kiss = distortion.toGlobe(localKiss);

	for (let i = 1; i <= resolution + 1; i++) {
		const time = startTime + (endTime - startTime) * i / resolution;
		const ta: GeoCircle = {
			coordinate: a.coordinate,
			radiusKm: aInitialKm + time,
		};
		const tb: GeoCircle = {
			coordinate: b.coordinate,
			radiusKm: bInitialKm + time,
		};

		const pair = geocircleIntersections(ta, tb);
		if (pair.length === 0) {
			console.warn("unexpected empty between", ta, tb, "of distance", localDistance, "for", i, "/", resolution, "@", time);
			continue;
		}
		left.push(pair[0]);
		right.push(pair[1]);
	}

	return [...left.reverse(), kiss, ...right];
}
