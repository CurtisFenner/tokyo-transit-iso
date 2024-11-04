export const EARTH_RADIUS_KM = 6378.1;
export const STANDARD_WALKING_SPEED_KPH = 4.5;

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

	magnitude(a: LocalCoordinate): number {
		return Math.sqrt(a.xKm ** 2 + a.yKm ** 2);
	}

	scale(scale: number, a: LocalCoordinate): LocalCoordinate {
		return {
			xKm: scale * a.xKm,
			yKm: scale * a.yKm,
		};
	}

	dot(a: LocalCoordinate, b: LocalCoordinate): number {
		return a.xKm * b.xKm + a.yKm * b.yKm;
	}

	unit(v: LocalCoordinate): LocalCoordinate {
		return this.scale(1 / this.magnitude(v), v);
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
			const su: LocalLine = { a: u[ui], b: u[ui + 1] };
			for (let vi = 0; vi + 1 < v.length; vi++) {
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

export function toTile(coordinate: Coordinate, options: { zoom: number }): { x: number, y: number } {
	const x3857 = coordinate.lon;
	const y3857 = Math.asinh(Math.tan(coordinate.lat * (Math.PI / 180)));

	// Y = asinh( tan( x * pi / 180 ))

	const x = 0.5 + x3857 / 360;
	const y = 0.5 + y3857 / (-2 * Math.PI);

	const n = 2 ** options.zoom;
	return {
		x: n * x,
		y: n * y,
	};
}

export function fromTile(xy: { x: number, y: number }, options: { zoom: number }): Coordinate {
	const n = 2 ** options.zoom;
	const x = xy.x / n;
	const y = xy.y / n;

	const x3857 = (x - 0.5) * 360;
	const y3857 = (y - 0.5) * (-2 * Math.PI);

	return {
		lon: x3857,
		lat: Math.atan(Math.sinh(y3857)) * (180 / Math.PI),
	};
}

export function simplifyPath(path: Coordinate[], options: { zoom: number, stepTiles: number }): Coordinate[] {
	const xys = path.map(c => toTile(c, options));
	const simplified = simplifyXYPath(xys, options.stepTiles);
	return simplified.map(s => fromTile(s, options));
}

export function xyDistance(a: { x: number, y: number }, b: { x: number, y: number }): number {
	const dx = a.x - b.x;
	const dy = a.y - b.y;
	return Math.sqrt(dx * dx + dy * dy);
}

export function simplifyXYPath(path: { x: number, y: number }[], stepSize: number): { x: number, y: number }[] {
	let sampleFrequency = stepSize / 5;
	const samples = [
		{ x: path[0].x, y: path[0].y, d: 0 },
	];
	let dFrom = 0;
	for (let i = 0; i + 1 < path.length; i++) {
		const from = path[i];
		const to = path[i + 1];
		const dx = to.x - from.x;
		const dy = to.y - from.y;
		const dm = Math.sqrt(dx ** 2 + dy ** 2);
		if (dm <= 1e-6) {
			dFrom += dm;
			continue;
		}

		let fromMyLine = 0;
		for (let d = samples[samples.length - 1].d + sampleFrequency; d <= dFrom + dm; d += sampleFrequency) {
			while (d < dFrom) {
				d += sampleFrequency;
			}

			const du = d - dFrom;
			const candidate = {
				x: from.x + dx * du / dm,
				y: from.y + dy * du / dm,
				d,
			};
			if (xyDistance(candidate, samples[samples.length - 1]) >= stepSize) {
				if (fromMyLine >= 2) {
					samples.pop();
					fromMyLine -= 1;
				}
				samples.push(candidate);
				fromMyLine += 1;
			}
		}

		dFrom += dm;
	}

	const last = path[path.length - 1];
	while (samples.length > 0) {
		const top = samples[samples.length - 1];
		const dx = top.x - last.x;
		const dy = top.y - last.y;
		const dm = Math.sqrt(dx ** 2 + dy ** 2);
		if (dm >= stepSize) {
			break;
		}
		samples.pop();
	}

	return [...samples.map(v => ({ x: v.x, y: v.y })), last];
}
