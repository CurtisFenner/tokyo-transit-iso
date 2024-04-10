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

export type LocalCoordinate = { xKm: number, yKm: number };
export type LocalLine = { a: LocalCoordinate, b: LocalCoordinate };

export class LocalPlane {
	private constructor(
		private readonly lonDegPerKm: number,
		private readonly latDegPerKm: number,
	) { }

	static nearPoint(coordinate: Coordinate): LocalPlane {
		const latDegPerKm = 360 / (EARTH_RADIUS_KM * 2 * Math.PI);
		const lonDegPerKm = latDegPerKm / Math.cos(coordinate.lat * Math.PI / 180);
		return new LocalPlane(lonDegPerKm, latDegPerKm);
	}

	toLocal(coordinate: Coordinate): LocalCoordinate {
		return {
			xKm: coordinate.lon / this.lonDegPerKm,
			yKm: coordinate.lat / this.latDegPerKm,
		};
	}

	toGlobe(local: LocalCoordinate): Coordinate {
		return {
			lon: local.xKm * this.lonDegPerKm,
			lat: local.yKm * this.latDegPerKm,
		};
	}

	subtract(a: LocalCoordinate, b: LocalCoordinate): LocalCoordinate {
		return {
			xKm: a.xKm - b.xKm,
			yKm: a.yKm - b.yKm,
		};
	}

	add(a: LocalCoordinate, b: LocalCoordinate): LocalCoordinate {
		return {
			xKm: a.xKm + b.xKm,
			yKm: a.yKm + b.yKm,
		};
	}

	angleOf(v: LocalCoordinate): number {
		return Math.atan2(v.yKm, v.xKm);
	}

	polar(radiusKm: number, angle: number) {
		return {
			xKm: radiusKm * Math.cos(angle),
			yKm: radiusKm * Math.sin(angle),
		};
	}

	distanceKm(a: LocalCoordinate, b: LocalCoordinate) {
		const dx = a.xKm - b.xKm;
		const dy = a.yKm - b.yKm;
		return Math.sqrt(dx ** 2 + dy ** 2);
	}

	directionTo(a: LocalCoordinate, b: LocalCoordinate): LocalCoordinate {
		const length = this.distanceKm(a, b);
		return {
			xKm: (b.xKm - a.xKm) / length,
			yKm: (b.yKm - a.yKm) / length,
		};
	}

	lineIntersection(u: LocalLine, v: LocalLine): LocalCoordinate | null {
		const udx = u.a.xKm - u.b.xKm;
		const udy = u.a.yKm - u.b.yKm;
		const vdx = v.a.xKm - v.b.xKm;
		const vdy = v.a.yKm - v.b.yKm;

		const denominator = udx * vdy - udy * vdx;
		if (denominator === 0) {
			return null;
		}

		const cross1 = u.a.xKm * u.b.yKm - u.a.yKm * u.b.xKm;
		const cross2 = v.a.xKm * v.b.yKm - v.a.yKm * v.b.xKm;

		const intersectX = (cross1 * vdx - udx * cross2) / denominator;
		const intersectY = (cross1 * vdy - udy * cross2) / denominator;

		return { xKm: intersectX, yKm: intersectY };
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
		const lowX = Math.min(segment.a.xKm, segment.b.xKm) - epsilon;
		const highX = Math.max(segment.a.xKm, segment.b.xKm) + epsilon;
		const lowY = Math.min(segment.a.yKm, segment.b.yKm) - epsilon;
		const highY = Math.max(segment.a.yKm, segment.b.yKm) + epsilon;
		return lowX <= point.xKm && point.xKm <= highX && lowY <= point.yKm && point.yKm <= highY;
	}

	lineCircleIntersection(line: LocalLine, center: LocalCoordinate, radius: number): LocalCoordinate[] {
		const dx = line.b.xKm - line.a.xKm;
		const dy = line.b.yKm - line.a.yKm;
		const drSquared = dx * dx + dy * dy;
		const determinant = line.a.xKm * line.b.yKm - line.b.xKm * line.a.yKm;
		const discriminant = radius * radius * drSquared - determinant * determinant;

		if (discriminant < 0) return [];

		const signDy = dy < 0 ? -1 : 1;
		const sqrtDiscriminant = Math.sqrt(discriminant);

		const intersectX1 = (determinant * dy + signDy * dx * sqrtDiscriminant) / drSquared + center.xKm;
		const intersectY1 = (-determinant * dx + Math.abs(dy) * sqrtDiscriminant) / drSquared + center.yKm;

		const intersectX2 = (determinant * dy - signDy * dx * sqrtDiscriminant) / drSquared + center.xKm;
		const intersectY2 = (-determinant * dx - Math.abs(dy) * sqrtDiscriminant) / drSquared + center.yKm;

		return [
			{ xKm: intersectX1, yKm: intersectY1 },
			{ xKm: intersectX2, yKm: intersectY2 },
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

{
	const lineU: LocalLine = {
		a: { xKm: 13, yKm: 8 * 13 - 7 },
		b: { xKm: 17, yKm: 8 * 17 - 7 },
	};
	const lineV: LocalLine = {
		a: { xKm: 31, yKm: -3 * 31 + 5 },
		b: { xKm: 37, yKm: -3 * 37 + 5 },
	};

	const plane = LocalPlane.nearPoint({ lat: 0, lon: 0 });

	const actual = plane.lineIntersection(lineU, lineV);
	if (!actual) throw new Error("expected localLineIntersection to return");
	if (Math.abs(actual.xKm - 12 / 11) >= 1e-5) {
		throw new Error("wrong xKm");
	} else if (Math.abs(actual.yKm - 19 / 11) >= 1e-5) {
		throw new Error("wrong yKm");
	}
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

	const localLeft = {
		xKm: localA.xKm + direction.xKm * parallel - direction.yKm * ortho,
		yKm: localA.yKm + direction.yKm * parallel + direction.xKm * ortho,
	};
	const localRight = {
		xKm: localA.xKm + direction.xKm * parallel + direction.yKm * ortho,
		yKm: localA.yKm + direction.yKm * parallel - direction.xKm * ortho,
	};

	return [
		distortion.toGlobe(localLeft),
		distortion.toGlobe(localRight),
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

	const localKiss: LocalCoordinate = {
		xKm: localA.xKm + (aInitialKm + startTime) * localDirection.xKm,
		yKm: localA.yKm + (aInitialKm + startTime) * localDirection.yKm,
	};
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
