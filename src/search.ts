import * as v2 from "./data/v2";
import { LocalPlane, STANDARD_WALKING_SPEED_KPH } from "./geometry";
import { HACHIKO_COORDINATES } from "./matchstations";

export type ArrivalTime = {
	coordinate: Coordinate,
	arrivalMinutes: number,
	finalWalkingLegMinutes: number,
};

export async function loadMatrices(): Promise<Matrices> {
	const fet = fetch("generated/morning-matrix.json.gze");
	const f = await fet;
	const gzipBlob = await f.blob();
	const decompressedStream = gzipBlob.stream().pipeThrough(new DecompressionStream("gzip"));
	const decompressedBlob = await new Response(decompressedStream).json();
	return decompressedBlob as Matrices;
}

function pluralize(
	count: number,
	singular: string,
	plural = singular.match(/([sxz]|[cs]h)$/)
		? singular + "es"
		: singular + "s",
) {
	return count === 1
		? `1 ${singular}`
		: `${count} ${plural}`;
}

export function formatTime(time: number): string {
	if (time < 60) {
		return pluralize(Math.floor(time), "minute");
	} else {
		return pluralize(Math.floor(time / 60), "hour") + " " + pluralize(Math.floor(time % 60), "minute");
	}
}

export function toLonLat(coordinate: Coordinate): [number, number] {
	return [coordinate.lon, coordinate.lat];
}

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

		circles.push({
			center: {
				x: localCoordinate.xKm,
				y: localCoordinate.yKm,
			},
			radius: radiusKm,
		});
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
