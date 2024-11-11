import * as v2 from "./data/v2";
import { LocalPlane, STANDARD_WALKING_SPEED_KPH } from "./geometry";
import { HACHIKO_COORDINATES } from "./matchstations";

export type ArrivalTime = {
	coordinate: Coordinate,
	arrivalMinutes: number,
	finalWalkingLegMinutes: number,
};

export async function isolines(
	arrivalTimes: ArrivalTime[],
	options: {
		maxJourneyMinutes: number,
		maxWalkMinutes: number,
	},
): Promise<{ boundaries: Coordinate[][] }> {
	const localPlane = LocalPlane.nearPoint(HACHIKO_COORDINATES);

	const circles = [];
	for (const arrivalTime of arrivalTimes) {
		const localCoordinate = localPlane.toLocal(arrivalTime.coordinate);

		const walkingMinutes = Math.min(
			options.maxWalkMinutes,
			Math.max(0, options.maxJourneyMinutes - arrivalTime.arrivalMinutes),
		);
		const radiusKm = walkingMinutes * STANDARD_WALKING_SPEED_KPH / 60;

		if (radiusKm > 0) {
			circles.push({
				center: {
					x: localCoordinate.xKm,
					y: localCoordinate.yKm,
				},
				radius: radiusKm,
			});
		}
	}

	const merged = v2.mergeCirclesIntoArcPaths(circles);
	{
		const boundaries: Coordinate[][] = [];
		for (const shape of merged) {
			const boundary = shape.map(l => localPlane.toGlobe({ xKm: l.x, yKm: l.y }))
			boundaries.push([...boundary]);
		}

		return { boundaries };
	}
}
