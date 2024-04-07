import * as maplibregl from "maplibre-gl";
import * as images from "./images";
import { HACHIKO_COORDINATES, loadWikidata } from "./matchstations";
import { renderRoutes } from "./routes";
import * as spatial from "./spatial";

function toSpherical(coordinate: Coordinate) {
	const latRad = Math.PI * 2 * coordinate.lat / 360;
	const lonRad = Math.PI * 2 * coordinate.lon / 360;
	return {
		x: Math.cos(lonRad) * Math.cos(latRad),
		y: Math.sin(lonRad) * Math.cos(latRad),
		z: Math.sin(latRad),
	};
}

export function earthGreatCircleDistanceKm(a: Coordinate, b: Coordinate) {
	const earthRadiusKm = 6378.1;
	const va = toSpherical(a);
	const vb = toSpherical(b);
	const dot = va.x * vb.x + va.y * vb.y + va.z * vb.z;
	const angleRad = Math.acos(dot);
	return angleRad * earthRadiusKm;
}

function toTimestamp(n: number) {
	const minutes = (n % 60).toFixed(0).padStart(2, "0");
	const hours = Math.floor(n / 60).toFixed(0).padStart(2, "0");
	return `${hours}:${minutes}`;
}

const map = new maplibregl.Map({
	container: document.getElementById("map")!,
	style: 'maplibre-style.json',
	center: [HACHIKO_COORDINATES.lon, HACHIKO_COORDINATES.lat],
	zoom: 9
});


async function loadMatrices(): Promise<Matrices> {
	const f = await fetch("generated/morning-matrix.json.gz");
	const gzipBlob = await f.blob();
	const decompressedStream = gzipBlob.stream().pipeThrough(new DecompressionStream("gzip"));
	const decompressedBlob = await new Response(decompressedStream).json();
	return decompressedBlob as Matrices;
}

type StationOffset = number;

function walkingMatrix(matrices: Matrices): [StationOffset, number][][] {
	const STANDARD_WALKING_SPEED_KPH = 4.5;
	const MAX_MINUTES = 30;
	const maxKm = MAX_MINUTES * STANDARD_WALKING_SPEED_KPH * 60;
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

		for (const toStation of grid.nearby(fromStation.coordinate, maxKm)) {
			const to = indices.get(toStation)!;
			const distanceKm = earthGreatCircleDistanceKm(fromStation.coordinate, toStation.coordinate);

			const minutes = distanceKm / STANDARD_WALKING_SPEED_KPH * 60;
			if (minutes < MAX_MINUTES) {
				walkingTransfers[from].push([to, minutes] satisfies [StationOffset, number]);
				walkingTransfers[to].push([from, minutes] satisfies [StationOffset, number]);
				count += 1;
			}
		}
	}

	return walkingTransfers;
}

function groupBy<K extends string, V>(seq: V[], f: (v: V) => K): Record<K, V[]> {
	const out: Record<K, V[]> = {} as Record<K, V[]>;
	for (const v of seq) {
		const k = f(v);
		if (!(k in out)) {
			out[k] = [];
		}
		out[k].push(v);
	}
	return out;
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
	const queue = [{ stationOffset, time: 0 }];
	while (queue.length > 0) {
		queue.sort((a, b) => b.time - a.time);
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
		matrixLineLogos.push(wikiLineLogos.get(matched.qID));
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

	loadingMessage.textContent = "";

	const { table, parentEdges } = renderRoutes(matrices, walking, SHIBUYA, matrixLineLogos);

	document.getElementById("panel")!.appendChild(table);

	// const stationIcon = L.icon({
	// 	iconUrl: "dot.png",
	// 	iconSize: [32, 32],
	// 	shadowUrl: "dot-shadow.png",
	// 	shadowSize: [32, 32],
	// });

	// const walkLineOptions: L.PolylineOptions = {
	// 	dashArray: "4 8",
	// };
	// const trainLineOptions: L.PolylineOptions = {
	// };

	const pathingTrainPolyline = [];
	const pathingWalkPolyline = [];

	for (const reached of parentEdges.filter(x => x)) {
		const station = matrices.stations[reached.i];

		// L.marker([station.coordinate.lat, station.coordinate.lon], { icon: stationIcon })
		// 	.addTo(map)
		// 	.bindTooltip(station.name + " in " + pluralize(Math.round(reached.time), "minute"));

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
		}
	}

	map.addSource("train-polyline-s", {
		type: "geojson",
		data: {
			type: "Feature",
			geometry: {
				type: "MultiLineString",
				coordinates: pathingTrainPolyline.map(cs => cs.map(c => [c.lon, c.lat])),
			},
			properties: {},
		},
	});
	map.addLayer({
		id: "train-polyline",
		type: "line",
		source: "train-polyline-s",
		layout: {
			"line-cap": "round",
			"line-join": "round",
		},
		paint: {
			"line-color": "#ABC",
			"line-width": 2,
		},
	});
}

main();
