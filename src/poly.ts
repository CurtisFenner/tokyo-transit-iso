import { LocalCoordinate, LocalPlane, STANDARD_WALKING_SPEED_KPH, WALK_MAX_KM, earthGreatCircleDistanceKm, growingHyperbolas, pathCircleIntersection } from "./geometry";
import * as spatial from "./spatial";
import { timed } from "./timer";

export type WalkingLocus = {
	coordinate: Coordinate,
	train: TrainLabel,
	radii: { timeMinutes: number, radiusKm: number }[],
	arrivalMinutes: number,
	id: number,
};

export function generateWalkingPolys<T extends WalkingLocus>(allLoci: T[]): { locus: T, poly: Coordinate[] }[] {
	const placedCircles = new spatial.Spatial<WalkingLocus>(12);
	const nonRedundantLoci: T[] = [];
	timed("non-redundant loci", () => {
		for (const circle of allLoci.sort((a, b) => a.arrivalMinutes - b.arrivalMinutes)) {
			const radius = circle.radii[circle.radii.length - 1];
			if (radius.radiusKm <= 1e-3) {
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

	const polys: { locus: T, poly: Coordinate[] }[] = [];

	timed("regions", () => {
		for (const circle of nonRedundantLoci) {
			const radius = circle.radii[circle.radii.length - 1];

			// Step by minute.
			// Find intersections with neighbors.

			const distort = LocalPlane.nearPoint(circle.coordinate);

			const restrictingArcs: LocalCoordinate[][] = [];
			timed("restrictingArcs", () => {
				for (const neighbor of placedCircles.nearby(circle.coordinate, WALK_MAX_KM * 2)) {
					const neighborRadius = neighbor.radii[circle.radii.length - 1].radiusKm;
					const distance = earthGreatCircleDistanceKm(circle.coordinate, neighbor.coordinate);
					if (distance >= radius.radiusKm + neighborRadius || neighbor.id === circle.id) {
						continue;
					}

					const arc = growingHyperbolas(
						{ coordinate: circle.coordinate, radiusKm: radius.radiusKm },
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
			for (let k = 0; k < resolution; k++) {
				const angle = k / resolution * Math.PI * 2 - Math.PI;
				localEdgeAngles.push({ angle, required: true });
			}

			timed("otherPoints", () => {
				const otherPoints: LocalCoordinate[] = [];
				for (let i = 0; i < restrictingArcs.length; i++) {
					const arc = restrictingArcs[i];
					otherPoints.push(...arc);
					otherPoints.push(...pathCircleIntersection(distort, arc, localCenter, radius.radiusKm));
				}

				for (const p of otherPoints) {
					localEdgeAngles.push({
						angle: distort.angleOf(distort.subtract(p, localCenter)),
						required: false,
					});
				}
			});

			const poly: Coordinate[] = [];
			const orthoRadius = radius.radiusKm / Math.cos((Math.PI * 2 / resolution) / 2);
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

				for (const { angle, required } of localEdgeAngles.sort((a, b) => a.angle - b.angle)) {
					const toEdge = distort.polar(orthoRadius, angle);
					const hit = polarIndex.castTo(distort, toEdge);
					if (!required && hit === toEdge) {
						continue;
					}
					poly.push(distort.toGlobe(distort.add(localCenter, hit)));
				}
			});
			polys.push({ locus: circle, poly });
		}
	});
	return polys;
}
