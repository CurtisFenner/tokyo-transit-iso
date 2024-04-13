import { LocalCoordinate, LocalPlane, STANDARD_WALKING_SPEED_KPH, WALK_MAX_KM, earthGreatCircleDistanceKm, growingHyperbolas, pathCircleIntersection } from "./geometry";
import * as spatial from "./spatial";
import { timed } from "./timer";

export type WalkingLocus = {
	coordinate: Coordinate,
	radiusKm: number,
	arrivalMinutes: number,
};

export function generateWalkingPolys<T extends WalkingLocus>(allLoci: T[]): {
	locus: T,
	poly: Coordinate[],
	external: boolean[],
	restrictingPaths: Coordinate[][],
	natural: Coordinate[],
}[] {
	const placedCircles = new spatial.Spatial<WalkingLocus>(12);
	const nonRedundantLoci: T[] = [];
	timed("non-redundant loci", () => {
		for (const circle of allLoci.sort((a, b) => a.arrivalMinutes - b.arrivalMinutes)) {
			if (circle.radiusKm <= 1e-3) {
				continue;
			}

			let contained = false;
			for (const nearby of placedCircles.nearby(circle.coordinate, WALK_MAX_KM)) {
				const nearbyRadiusKm = (circle.arrivalMinutes - nearby.arrivalMinutes) * STANDARD_WALKING_SPEED_KPH / 60;
				const centerDistance = earthGreatCircleDistanceKm(nearby.coordinate, circle.coordinate);
				if (centerDistance <= nearbyRadiusKm) {
					contained = true;
					break;
				}
			}
			if (contained) {
				continue;
			}
			placedCircles.add(circle);
			nonRedundantLoci.push(circle);
		}
	});

	const polys: {
		locus: T,
		poly: Coordinate[],
		external: boolean[],
		restrictingPaths: Coordinate[][],
		natural: Coordinate[],
	}[] = [];

	timed("regions", () => {
		for (const circle of nonRedundantLoci) {
			// Step by minute.
			// Find intersections with neighbors.

			const distort = LocalPlane.nearPoint(circle.coordinate);

			const restrictingArcs: LocalCoordinate[][] = [];
			timed("restrictingArcs", () => {
				for (const neighbor of placedCircles.nearby(circle.coordinate, WALK_MAX_KM * 2)) {
					const neighborRadius = neighbor.radiusKm;
					const distance = earthGreatCircleDistanceKm(circle.coordinate, neighbor.coordinate);
					if (distance >= circle.radiusKm + neighborRadius || neighbor === circle) {
						continue;
					}

					const arc = growingHyperbolas(
						{ coordinate: circle.coordinate, radiusKm: circle.radiusKm },
						(STANDARD_WALKING_SPEED_KPH / 60) * -circle.arrivalMinutes,
						{ coordinate: neighbor.coordinate, radiusKm: neighborRadius },
						(STANDARD_WALKING_SPEED_KPH / 60) * -neighbor.arrivalMinutes,
					);
					if (arc !== null) {
						restrictingArcs.push(arc.map(it => distort.toLocal(it)));
					}
				}
			});

			const localCenter = distort.toLocal(circle.coordinate);
			const localEdgeAngles: { angle: number, required: boolean }[] = [];
			const resolution = 12;
			const localNatural: LocalCoordinate[] = [];
			const orthoRadius = circle.radiusKm / Math.cos((Math.PI * 2 / resolution) / 2);
			for (let k = 0; k < resolution; k++) {
				const angle = k / resolution * Math.PI * 2 - Math.PI;
				localEdgeAngles.push({ angle, required: true });
				localNatural.push(distort.add(localCenter, distort.polar(orthoRadius, angle)));
			}
			localNatural.push(localNatural[0]);
			const natural: Coordinate[] = localNatural.map(x => distort.toGlobe(x));

			timed("otherPoints", () => {
				const otherPoints: LocalCoordinate[] = [];
				for (let i = 0; i < restrictingArcs.length; i++) {
					const arc = restrictingArcs[i];
					otherPoints.push(...arc);
					otherPoints.push(...distort.pathIntersections(arc, localNatural));
				}

				for (const p of otherPoints) {
					localEdgeAngles.push({
						angle: distort.angleOf(distort.subtract(p, localCenter)),
						required: false,
					});
				}
			});

			const poly: Coordinate[] = [];
			const external: boolean[] = [];
			timed("raycasting", () => {
				const restrictingSegments = restrictingArcs.flatMap(arc => {
					const segments = [];
					const relativeArc = arc.map(p => distort.subtract(p, localCenter));
					for (let i = 0; i + 1 < relativeArc.length; i++) {
						segments.push({ a: relativeArc[i], b: relativeArc[i + 1] });
					}
					return segments;
				});
				const polarIndex = timed("new spatial.PolarIndex", () => new spatial.PolarIndex(
					restrictingSegments
				));

				const naturalIndex = new spatial.PolarIndex(
					localNatural.map((_, i) => {
						return {
							a: distort.subtract(localNatural[i], localCenter),
							b: distort.subtract(localNatural[(i + 1) % localNatural.length], localCenter),
						}
					})
				);

				for (const { angle, required } of localEdgeAngles.sort((a, b) => a.angle - b.angle)) {
					const toEdge = distort.polar(orthoRadius, angle);
					const toNatural = naturalIndex.castTo(distort, toEdge);
					const hit = polarIndex.castTo(distort, toNatural);
					if (!required && hit === toNatural) {
						continue;
					}
					poly.push(distort.toGlobe(distort.add(localCenter, hit)));
					external.push(required && hit === toNatural);
				}
			});
			natural.push(natural[0]);

			polys.push({
				locus: circle,
				poly,
				external,
				restrictingPaths: restrictingArcs.map(arc =>
					arc.map(local => distort.toGlobe(local)),
				),
				natural,
			});
		}
	});
	return polys;
}
