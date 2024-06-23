import * as maplibregl from "maplibre-gl";
import * as images from "./images";
import { HACHIKO_COORDINATES, loadWikidata } from "./matchstations";
import { renderRoutes } from "./routes";
import * as spatial from "./spatial";
import { STANDARD_WALKING_SPEED_KPH, WALK_MAX_KM, WALK_MAX_MIN, earthGreatCircleDistanceKm } from "./geometry";
import { printTimeTree, timed } from "./timer";
import { MinHeap } from "./heap";
import { assignTiles, groupAndOutlineTiles } from "./regions";
import * as nomin from "./nomin";

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

function walkingMatrix(matrices: Matrices): [StationOffset, number][][] {
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

		for (const toStation of grid.nearby(fromStation.coordinate, WALK_MAX_KM)) {
			const to = indices.get(toStation)!;
			const distanceKm = earthGreatCircleDistanceKm(fromStation.coordinate, toStation.coordinate);

			const minutes = distanceKm / STANDARD_WALKING_SPEED_KPH * 60;
			if (minutes < WALK_MAX_MIN) {
				walkingTransfers[from].push([to, minutes] satisfies [StationOffset, number]);
				walkingTransfers[to].push([from, minutes] satisfies [StationOffset, number]);
				count += 1;
			}
		}
	}

	return walkingTransfers;
}

export function dijkstras(
	trainMatrix: Matrix,
	walkingMatrix: [StationOffset, number][][],
	stationOffset: StationOffset,
	matrices: Matrices,
) {
	const trainPenaltyMinutes = 3;
	const walkPenaltyMinutes = 1;

	const searchLog = [];

	const visited: {
		time: number,
		parent: null
		| { via: "walk", from: StationOffset }
		| { via: "train", train: MatrixDistance, from: StationOffset },
	}[] = [];
	visited[stationOffset] = { time: 0, parent: null };

	const queue = new MinHeap<{ stationOffset: number, time: number }>((a, b) => {
		if (a.time < b.time) {
			return "<";
		}
		return ">";
	});
	queue.push({ stationOffset, time: 0 });

	while (queue.size() > 0) {
		const top = queue.pop()!;
		searchLog.push(top);

		const station = matrices.stations[top.stationOffset];
		if (earthGreatCircleDistanceKm(station.coordinate, { lat: 35.658514, lon: 139.70133 }) > 150) {
			continue;
		}

		// visited[top] must already be updated.

		for (const walkingNeighbor of walkingMatrix[top.stationOffset]) {
			const arrivalStationOffset = walkingNeighbor[0];
			const arrivalTime = top.time + walkingNeighbor[1] + walkPenaltyMinutes;
			if (!visited[arrivalStationOffset] || visited[arrivalStationOffset].time > arrivalTime) {
				visited[arrivalStationOffset] = {
					parent: {
						via: "walk",
						from: top.stationOffset,
					},
					time: arrivalTime,
				};
				queue.push({ stationOffset: arrivalStationOffset, time: arrivalTime });
			}
		}

		for (const neighbor of trainMatrix.distances[top.stationOffset]) {
			if (!neighbor.minutes) {
				// A null or 0 should be ignored.
				continue;
			}

			const arrivalStationOffset = neighbor.to;
			const arrivalTime = top.time + neighbor.minutes.avg + trainPenaltyMinutes;
			if (!visited[arrivalStationOffset] || visited[arrivalStationOffset].time > arrivalTime) {
				visited[arrivalStationOffset] = {
					parent: {
						via: "train",
						train: neighbor,
						from: top.stationOffset,
					},
					time: arrivalTime,
				};
				queue.push({ stationOffset: arrivalStationOffset, time: arrivalTime });
			}
		}
	}

	return visited;
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
	const walking = walkingMatrix(matrices);
	const after = performance.now();
	console.log(after - before, "ms calculating walking");

	await sleep(60);
	loadingMessage.textContent = "Calculating travel times...";
	await sleep(60);

	const SHIBUYA = matrices.stations.findIndex(x => x.name.includes("渋谷"))!;

	const parentEdges = await renderRoutes(matrices, walking, SHIBUYA);

	await sleep(60);

	const pathingTrainPolyline = [];
	const pathingWalkPolyline = [];

	const circles: (WalkingLocus & { train: TrainLabel })[] = [];
	const minuteIso = 60;

	for (const reached of parentEdges.filter(x => x && x.time < 60 * 3)) {
		const station = matrices.stations[reached.i];

		const parent = reached.parent;
		if (parent) {
			const parentStation = matrices.stations[parent.from];
			if (parent?.via === "train") {
				const line: Coordinate[] = [];
				for (const stop of parent.train.route) {
					const viaStation = matrices.stations[stop.departing];
					line.push(viaStation.coordinate);
				}
				line.push(station.coordinate);
				pathingTrainPolyline.push(line);
			} else if (parent?.via === "walk") {
				const line: Coordinate[] = [station.coordinate, parentStation.coordinate];
				pathingWalkPolyline.push(line);
			}

			if (parent?.via === "train") {
				const hoursAfterArrival = Math.max(0, minuteIso - reached.time) / 60;;
				const circle = {
					arrivalMinutes: reached.time,
					coordinate: station.coordinate,
					radiusKm: Math.min(WALK_MAX_KM, hoursAfterArrival * STANDARD_WALKING_SPEED_KPH),
					train: parent.train.route[0],
					id: reached.i,
				};
				circles.push(circle);
			}
		}
	}

	await sleep(60);
	loadingMessage.textContent = "Rendering map...";
	await sleep(60);

	const times = [120, 90, 60, 30];

	await addGridRegions(matrixLineLogos, circles, times[0]);

	const isolinesGeojson = await timed("isolines", () => isolines(circles, times));
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
) {
	const loops = [];
	for (const maxMinutes of times) {
		const tiles = await timed(`assignTiles(${maxMinutes})`, () => assignTiles(circles, {
			boxSize: 0.5,
			maxRadiusKm: WALK_MAX_KM,
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
	maxMinutes: number,
) {
	const tiles = await timed("assignTiles", () => assignTiles(circles, {
		boxSize: 0.5,
		maxRadiusKm: WALK_MAX_KM,
		speedKmPerMin: STANDARD_WALKING_SPEED_KPH / 60,
		maxMinutes,
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
			collapser.parentElement!.style.right = "calc(1.5rem - var(--full-width))";
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
