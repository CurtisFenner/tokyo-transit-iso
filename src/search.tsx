import { timed } from "./data/timer";
import { STANDARD_WALKING_SPEED_KPH } from "./geometry";
import { assignTiles, groupAndOutlineTiles } from "./regions";

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
	circles: ArrivalTime[],
	options: {
		maxJourneyMinutes: number,
		maxWalkMinutes: number,
	},
) {
	const tiles = await timed(`assignTiles(${options.maxJourneyMinutes})`, () => assignTiles(circles, {
		boxKm: 0.8,
		maxRadiusKm: options.maxWalkMinutes * STANDARD_WALKING_SPEED_KPH / 60,
		speedKmPerMin: STANDARD_WALKING_SPEED_KPH / 60,
		maxMinutes: options.maxJourneyMinutes,
	}));
	const allInside = new Set<string>();
	for (const tile of tiles.cells) {
		allInside.add(`${tile.tile.gx},${tile.tile.gy}`);
	}
	const patches = await timed(`groupAndOutlineTiles(${options.maxJourneyMinutes})`, async () => {
		return groupAndOutlineTiles(tiles.cells.map(x => {
			return {
				tile: x.tile,
				arrival: null,
			};
		}));
	});

	const boundaries: Coordinate[][] = [];
	for (const patch of patches) {
		for (const boundary of patch.boundaries) {
			const coordinates = boundary.map(x => x.toCorner).map(cornerID => tiles.corners.get(cornerID)!);
			boundaries.push(coordinates);
		}
	}

	return {
		boundaries,
	};
}
