import * as maplibregl from "maplibre-gl";
import * as images from "./images";
import { HACHIKO_COORDINATES } from "./matchstations";
import * as spatial from "./spatial";
import { STANDARD_WALKING_SPEED_KPH, earthGreatCircleDistanceKm } from "./geometry";
import { timed } from "./timer";
import { assignTiles, groupAndOutlineTiles } from "./regions";
import { LabeledDistanceGraph, dijkstras } from "./graph";

export type WalkingLocus = {
	coordinate: Coordinate,
	radiusKm: number,
	arrivalMinutes: number,
};

export async function loadMatrices(): Promise<Matrices> {
	const fet = fetch("generated/morning-matrix.json.gze");
	const f = await fet;
	const gzipBlob = await f.blob();
	const decompressedStream = gzipBlob.stream().pipeThrough(new DecompressionStream("gzip"));
	const decompressedBlob = await new Response(decompressedStream).json();
	return decompressedBlob as Matrices;
}

export type StationOffset = number;

export function walkingMatrix(
	matrices: Matrices,
	options: {
		maxWalkMinutes: number,
	},
): { to: StationOffset, minutes: number }[][] {
	const maxWalkKm = STANDARD_WALKING_SPEED_KPH * options.maxWalkMinutes;
	let count = 0;

	const walkingTransfers: { to: StationOffset, minutes: number }[][] = [];
	for (let i = 0; i < matrices.stations.length; i++) {
		walkingTransfers[i] = [];
	}

	const grid = new spatial.Spatial<MatrixStation>(12);
	const indices = new Map<MatrixStation, number>();
	for (let i = 0; i < matrices.stations.length; i++) {
		indices.set(matrices.stations[i], i);
		grid.add(matrices.stations[i]);
	}

	for (let from = 0; from < matrices.stations.length; from++) {
		const fromStation = matrices.stations[from];

		for (const toStation of grid.nearby(fromStation.coordinate, maxWalkKm)) {
			const to = indices.get(toStation)!;
			const distanceKm = earthGreatCircleDistanceKm(fromStation.coordinate, toStation.coordinate);

			const minutes = distanceKm / STANDARD_WALKING_SPEED_KPH * 60;
			if (minutes < options.maxWalkMinutes) {
				walkingTransfers[from].push({ to, minutes });
				walkingTransfers[to].push({ to: from, minutes });
				count += 1;
			}
		}
	}

	return walkingTransfers;
}

export type WalkingEdge = { via: "walking" };
export type TrainEdge = { via: "train", route: TrainLabel[] };

export function findPathsThroughTrains(
	trainMatrix: MatrixDistance[][],
	walkingMatrix: { to: StationOffset, minutes: number }[][],
	initialMinutes: Map<StationOffset, number>,
): Map<
	StationOffset,
	{ parent: null; distance: number; initial: null }
	| { parent: number; edge: TrainEdge | WalkingEdge, distance: number }
> {
	const trainPenaltyMinutes = 3;
	const walkPenaltyMinutes = 1;

	const paths = dijkstras(
		new Map(
			[...initialMinutes].map(entry => {
				return [entry[0], { distance: entry[1], initial: null }];
			})
		),
		new class implements LabeledDistanceGraph<StationOffset, TrainEdge | WalkingEdge> {
			neighbors(fromIndex: StationOffset): {
				edge: TrainEdge | WalkingEdge,
				node: StationOffset,
				distance: number,
			}[] {
				const walkingNeighbors = [];
				for (const walkingNeighbor of walkingMatrix[fromIndex]) {
					walkingNeighbors.push({
						edge: { via: "walking" } satisfies WalkingEdge,
						distance: walkPenaltyMinutes + walkingNeighbor.minutes,
						node: walkingNeighbor.to,
					});
				}

				const trainNeighbors = [];
				for (const neighbor of trainMatrix[fromIndex]) {
					if (!neighbor.minutes) {
						// A null or 0 should be ignored.
						continue;
					}

					trainNeighbors.push({
						edge: { via: "train", route: neighbor.route } satisfies TrainEdge,
						distance: neighbor.minutes.avg + trainPenaltyMinutes,
						node: neighbor.to,
					});
				}

				return [...walkingNeighbors, ...trainNeighbors];
			}
		}
	);

	return paths;
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

export function looped<T>(x: T[]): T[] {
	if (x.length === 0) {
		throw new Error("looped: must be non empty");
	}

	return [...x, x[0]];
}

export async function isolines(
	circles: WalkingLocus[],
	maxMinutes: number,
	options: {
		maxWalkMinutes: number,
	},
) {
	const tiles = await timed(`assignTiles(${maxMinutes})`, () => assignTiles(circles, {
		boxKm: 0.8,
		maxRadiusKm: options.maxWalkMinutes * STANDARD_WALKING_SPEED_KPH / 60,
		speedKmPerMin: STANDARD_WALKING_SPEED_KPH / 60,
		maxMinutes,
	}));
	const allInside = new Set<string>();
	for (const tile of tiles.cells) {
		allInside.add(`${tile.tile.gx},${tile.tile.gy}`);
	}
	const patches = await timed(`groupAndOutlineTiles(${maxMinutes})`, async () => {
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
		maxMinutes,
		boundaries,
	};
}

export async function addGridRegions(
	map: maplibregl.Map,
	matrixLineLogos: (images.LogoRect | undefined)[],
	circles: (WalkingLocus & { train: TrainLabel })[],
	options: {
		maxWalkMinutes: number,
		maxJourneyMinutes: number,
	},
) {
	const tiles = await timed("assignTiles", () => assignTiles(circles, {
		boxKm: 0.8,
		maxRadiusKm: options.maxWalkMinutes / 60 * STANDARD_WALKING_SPEED_KPH,
		speedKmPerMin: STANDARD_WALKING_SPEED_KPH / 60,
		maxMinutes: options.maxJourneyMinutes,
	}));

	const patches = await timed("groupAndOutlineTiles", async () => groupAndOutlineTiles(tiles.cells));

	const polygonsByLineID = new Map<number, [number, number][][][]>();

	for (const patch of patches) {
		const lineID = patch.arrival.train.line || -1;

		const polygon = looped(patch.boundaries[0].map(x => x.toCorner))
			.map(cornerID => tiles.corners.get(cornerID)!)
			.map(toLonLat);

		const linePolygons = polygonsByLineID.get(lineID) || [];
		linePolygons.push([polygon]);
		polygonsByLineID.set(lineID, linePolygons);
	}

	for (const [lineID, linePolygons] of polygonsByLineID) {
		const logoData = matrixLineLogos[lineID];
		const logoColor = logoData?.color || { r: 0.5, g: 0.5, b: 0.5 };
		const lineColor = images.toCSSColor(logoColor);
		const sourceID = "hexes-" + lineID;
		map.addSource(sourceID, {
			type: "geojson",
			data: {
				type: "Feature",
				geometry: {
					type: "MultiPolygon",
					coordinates: linePolygons,
				},
				properties: {},
			},
		});

		map.addLayer({
			id: sourceID + "-fill",
			type: "fill",
			source: sourceID,
			layout: {},
			paint: {
				"fill-color": lineColor,
				"fill-opacity": 0.125,
				"fill-outline-color": images.toCSSColor(logoColor, 0.25),
			},
		});
	}
}
