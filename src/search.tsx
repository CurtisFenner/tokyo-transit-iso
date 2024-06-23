import * as maplibregl from "maplibre-gl";
import * as images from "./images";
import { HACHIKO_COORDINATES, loadWikidata } from "./matchstations";
import * as spatial from "./spatial";
import { STANDARD_WALKING_SPEED_KPH, earthGreatCircleDistanceKm } from "./geometry";
import { printTimeTree, timed } from "./timer";
import { assignTiles, groupAndOutlineTiles } from "./regions";
import * as nomin from "./nomin";
import ReactDOM from "react-dom/client";
import React from "react";
import { PlaceList } from "./components/place-list";
import { LabeledDistanceGraph, dijkstras } from "./graph";

type WalkingLocus = {
	coordinate: Coordinate,
	radiusKm: number,
	arrivalMinutes: number,
};

const map = new maplibregl.Map({
	container: document.getElementById("map")!,
	style: 'maplibre-style.json',
	center: [HACHIKO_COORDINATES.lon, HACHIKO_COORDINATES.lat],
	zoom: 9,
	attributionControl: false,
});
map.addControl(new maplibregl.AttributionControl(), "bottom-left");

async function loadMatrices(): Promise<Matrices> {
	const fet = fetch("generated/morning-matrix.json.gze");
	const f = await fet;
	const gzipBlob = await f.blob();
	const decompressedStream = gzipBlob.stream().pipeThrough(new DecompressionStream("gzip"));
	const decompressedBlob = await new Response(decompressedStream).json();
	return decompressedBlob as Matrices;
}

type StationOffset = number;

function walkingMatrix(
	matrices: Matrices,
	options: {
		maxWalkMinutes: number,
	},
): [StationOffset, number][][] {
	const maxWalkKm = STANDARD_WALKING_SPEED_KPH * options.maxWalkMinutes;
	let count = 0;

	const walkingTransfers: [StationOffset, number][][] = [];
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
				walkingTransfers[from].push([to, minutes] satisfies [StationOffset, number]);
				walkingTransfers[to].push([from, minutes] satisfies [StationOffset, number]);
				count += 1;
			}
		}
	}

	return walkingTransfers;
}

export type WalkingEdge = { via: "walking" };
export type TrainEdge = { via: "train", route: TrainLabel[] };

export function findPathsThroughTrains(
	trainMatrix: Matrix,
	walkingMatrix: [StationOffset, number][][],
	stationOffset: StationOffset,
	matrices: Matrices,
): Map<
	StationOffset,
	{ parent: null; distance: number; initial: null }
	| { parent: number; edge: TrainEdge | WalkingEdge, distance: number }
> {
	const trainPenaltyMinutes = 3;
	const walkPenaltyMinutes = 1;

	const paths = dijkstras(
		new Map([[stationOffset, { distance: 0, initial: null }]]),
		new class implements LabeledDistanceGraph<StationOffset, TrainEdge | WalkingEdge> {
			neighbors(fromIndex: StationOffset): {
				edge: TrainEdge | WalkingEdge,
				node: StationOffset,
				distance: number,
			}[] {
				const station = matrices.stations[fromIndex];
				if (earthGreatCircleDistanceKm(station.coordinate, HACHIKO_COORDINATES) > 150) {
					return [];
				}

				const walkingNeighbors = [];
				for (const walkingNeighbor of walkingMatrix[fromIndex]) {
					walkingNeighbors.push({
						edge: { via: "walking" } satisfies WalkingEdge,
						distance: walkPenaltyMinutes + walkingNeighbor[1],
						node: walkingNeighbor[0],
					});
				}

				const trainNeighbors = [];
				for (const neighbor of trainMatrix.distances[fromIndex]) {
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

function sleep(ms: number): Promise<number> {
	const before = performance.now();
	return new Promise(resolve => {
		setTimeout(() => {
			const after = performance.now();
			resolve(after - before);
		}, ms);
	});
}

const loadingMessage = document.getElementById("loading-message")!;

async function main() {
	loadingMessage.textContent = "Waiting for train station map...";
	const matrices = await loadMatrices();
	loadingMessage.textContent = "Waiting for localization...";

	const wikidata = await loadWikidata();
	wikidata.matchStations(matrices.stations);
	console.log(wikidata.matchedStations.size, "of", matrices.stations.length, "stations matched");
	wikidata.matchLines(matrices);
	console.log(wikidata.matchedLines.size, "of", matrices.lines.length, "lines matched");

	await sleep(60);
	loadingMessage.textContent = "Waiting for logos...";
	await sleep(60);

	const wikiLineLogos = await images.loadLineLogos();
	const matrixLineLogos = [];
	for (const line of matrices.lines) {
		const matched = wikidata.matchedLines.get(line);
		if (!matched) {
			matrixLineLogos.push(undefined);
			continue;
		}
		matrixLineLogos.push(wikiLineLogos.rectangles[matched.qID]);
	}

	await sleep(60);
	loadingMessage.textContent = "Calculating walking distances...";
	await sleep(60);

	const before = performance.now();
	const options = {
		maxWalkMinutes: 30,
		maxJourneyMinutes: 60,
	};
	const walking = walkingMatrix(matrices, options);
	const after = performance.now();
	console.log(after - before, "ms calculating walking");

	await sleep(60);
	loadingMessage.textContent = "Calculating travel times...";
	await sleep(60);

	const SHIBUYA = matrices.stations.findIndex(x => x.name.includes("渋谷"))!;

	const parentEdges = await findPathsThroughTrains(matrices.matrices[0], walking, SHIBUYA, matrices);

	await sleep(60);

	const pathingTrainPolyline = [];
	const pathingWalkPolyline = [];

	const circles: (WalkingLocus & { train: TrainLabel })[] = [];

	for (const [reachedOffset, pathData] of [...parentEdges].filter(kv => kv[1].distance < options.maxJourneyMinutes)) {
		const station = matrices.stations[reachedOffset];

		if (pathData.parent !== null) {
			const parentStation = matrices.stations[pathData.parent];
			if (pathData.edge.via === "train") {
				const line: Coordinate[] = [];
				for (const stop of pathData.edge.route) {
					const viaStation = matrices.stations[stop.departing];
					line.push(viaStation.coordinate);
				}
				line.push(station.coordinate);
				pathingTrainPolyline.push(line);

				const hoursAfterArrival = Math.max(0, options.maxJourneyMinutes - pathData.distance) / 60;;
				const circle = {
					arrivalMinutes: pathData.distance,
					coordinate: station.coordinate,
					radiusKm: Math.min(options.maxWalkMinutes / 60, hoursAfterArrival) * STANDARD_WALKING_SPEED_KPH,
					train: pathData.edge.route[0],
					id: reachedOffset,
				};
				circles.push(circle);
			} else if (pathData.edge.via === "walking") {
				const line: Coordinate[] = [station.coordinate, parentStation.coordinate];
				pathingWalkPolyline.push(line);
			}
		}
	}

	await sleep(60);
	loadingMessage.textContent = "Rendering map...";
	await sleep(60);

	const times = [options.maxJourneyMinutes];

	await addGridRegions(matrixLineLogos, circles, options);

	const isolinesGeojson = await timed("isolines", () => isolines(circles, times, options));
	const allLines = [];
	for (const line of isolinesGeojson) {
		for (const path of line.boundaries) {
			const geojson = looped(path.map(toLonLat));
			allLines.push(geojson);
		}
	}
	map.addSource("isolines", {
		type: "geojson",
		data: {
			type: "Feature",
			geometry: {
				type: "MultiLineString",
				coordinates: allLines,
			},
			properties: {},
		},
	});

	map.addLayer({
		id: "isolines-polyline",
		type: "line",
		source: "isolines",
		layout: {
			"line-cap": "round",
			"line-join": "round",
		},
		paint: {
			"line-opacity": 0.75,
			"line-color": "#444",
			"line-width": 1,
		},
	});

	loadingMessage.textContent = "";

	console.log(printTimeTree().join("\n"));
}

function toLonLat(coordinate: Coordinate): [number, number] {
	return [coordinate.lon, coordinate.lat];
}

function looped<T>(x: T[]): T[] {
	if (x.length === 0) {
		throw new Error("looped: must be non empty");
	}

	return [...x, x[0]];
}

async function isolines(
	circles: (WalkingLocus & { train: TrainLabel })[],
	times: number[],
	options: {
		maxWalkMinutes: number,
	},
) {
	const loops = [];
	for (const maxMinutes of times) {
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
		loops.push({
			maxMinutes,
			boundaries,
		});
	}
	return loops;
}

async function addGridRegions(
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

main();

for (const collapser of document.body.getElementsByClassName("collapser")) {
	if (!(collapser instanceof HTMLButtonElement)) {
		throw new Error("collapser class should only be applied to buttons");
	}

	let collapsed = false;
	collapser.onclick = () => {
		collapsed = !collapsed;
		if (collapsed) {
			collapser.parentElement!.style.right = "calc(-1.5rem - var(--full-width))";
			collapser.style.transform = "rotate(180deg)";
		} else {
			collapser.parentElement!.style.right = "0px";
			collapser.style.transform = "rotate(0deg)";
		}
	};

	collapser.disabled = false;
}

console.log(nomin.kantoBox);

const inPlace = document.getElementById("in-place") as HTMLInputElement;
const inPlaceButton = document.getElementById("in-place-button") as HTMLButtonElement;

async function searchForPlace() {
	if (inPlace.value.trim() !== "") {
		const results = await nomin.searchForPlace(inPlace.value.trim());
		for (const result of results) {

		}
	}
}

inPlace.onkeydown = e => {
	if (e.key === "Enter") {
		searchForPlace();
	}
};


ReactDOM.createRoot(document.getElementById("root")!).render(
	<React.StrictMode>
		<PlaceList
			initial={[
				{
					name: "Hachiko",
					maxMinutes: 60,
					coordinate: HACHIKO_COORDINATES,
				}
			]}
		/>
	</React.StrictMode>
);
