import * as maplibregl from "maplibre-gl";
import * as images from "./images";
import { HACHIKO_COORDINATES, loadWikidata } from "./matchstations";
import { renderRoutes } from "./routes";
import * as spatial from "./spatial";
import { STANDARD_WALKING_SPEED_KPH, WALK_MAX_KM, WALK_MAX_MIN, earthGreatCircleDistanceKm, growingHyperbolas, localDistanceKm, localDistortion, localPathIntersections, pathCircleIntersection, toGlobe, toLocalPlane } from "./geometry";
import { WalkingLocus, generateWalkingPolys } from "./poly";

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
	const fet = fetch("generated/morning-matrix.json.gze");
	console.log("fet:", fet);
	const f = await fet;
	console.log("f:", f);
	const gzipBlob = await f.blob();
	console.log("gzipBlob:", gzipBlob);
	const decompressedStream = gzipBlob.stream().pipeThrough(new DecompressionStream("gzip"));
	const decompressedBlob = await new Response(decompressedStream).json();
	console.log("decompressedBlob", decompressedBlob);
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

function groupBy<K, V>(seq: V[], f: (v: V) => K): Map<K, V[]> {
	const out = new Map<K, V[]>();
	for (const v of seq) {
		const k = f(v);
		const list = out.get(k) || [];
		list.push(v);
		out.set(k, list);
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


	const { table, parentEdges } = renderRoutes(matrices, walking, SHIBUYA, matrixLineLogos);

	document.getElementById("panel")!.appendChild(table);
	await sleep(60);

	const pathingTrainPolyline = [];
	const pathingWalkPolyline = [];

	const circles: WalkingLocus[] = [];
	const minuteIsos = [60];

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
				const circle = {
					arrivalMinutes: reached.time,
					coordinate: station.coordinate,
					radii: minuteIsos.map(timeMinutes => {
						const hoursAfterArrival = Math.max(0, timeMinutes - reached.time) / 60;
						const radiusKm = Math.min(WALK_MAX_KM, hoursAfterArrival * STANDARD_WALKING_SPEED_KPH);
						return {
							timeMinutes,
							radiusKm,
						};
					}),
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

	const stationWalkRegions = generateWalkingPolys(circles);

	const regionsByLine = groupBy(stationWalkRegions, x => x.locus.train.line);

	for (const [lineID, polys] of regionsByLine) {
		const sourceID = "train-radius-" + String(lineID);
		map.addSource(sourceID, {
			type: "geojson",
			data: {
				type: "Feature",
				geometry: {
					type: "MultiPolygon",
					coordinates: polys
						.map(poly => [...poly.poly, poly.poly[0]])
						.map(poly => [poly.map<[number, number]>(c => [c.lon, c.lat])]),
				},
				properties: {},
			},
		});
		const lineColor = images.toCSSColor(matrixLineLogos[lineID || -1]?.color || { r: 0.5, g: 0.5, b: 0.5 });
		const layerID = "train-radius-" + String(lineID) + "-layer";
		map.addLayer({
			id: layerID,
			type: "fill",
			source: sourceID,
			layout: {},
			paint: {
				"fill-color": lineColor,
				"fill-opacity": 0.5,
				"fill-outline-color": lineColor,
			},
		});

		const popup = new maplibregl.Popup({
			closeButton: false,
			closeOnClick: false
		});
		map.on("mousemove", layerID, e => {
			if (!e.features) {
				return
			}

			const geometry = e.features[0].geometry;
			const line = matrices.lines[lineID || -1];

			const lines = document.createElement("div");
			const jpLine = document.createElement("div");
			jpLine.textContent = line?.name;
			lines.appendChild(jpLine);
			const wikiLine = wikidata.matchedLines.get(line);
			if (wikiLine) {
				if (wikiLine.line_en) {
					const enLine = document.createElement("div");
					enLine.textContent = wikiLine.line_en;
					lines.appendChild(enLine);
				}
			}
			popup.setLngLat(e.lngLat).setDOMContent(lines).addTo(map);
			popup._container.classList.add("no-hover");
		});

		map.on("mouseleave", layerID, e => {
			if (popup) {
				popup.remove();
			}
		});
	}

	// map.addSource("train-polyline-s", {
	// 	type: "geojson",
	// 	data: {
	// 		type: "Feature",
	// 		geometry: {
	// 			type: "MultiLineString",
	// 			coordinates: allArcs.map(cs => cs.map(c => [c.lon, c.lat])),
	// 		},
	// 		properties: {},
	// 	},
	// });
	// map.addLayer({
	// 	id: "train-polyline",
	// 	type: "line",
	// 	source: "train-polyline-s",
	// 	layout: {
	// 		"line-cap": "round",
	// 		"line-join": "round",
	// 	},
	// 	paint: {
	// 		"line-color": "#58A",
	// 		"line-width": 1,
	// 	},
	// });

	loadingMessage.textContent = "";
}

main();
