import * as maplibregl from "maplibre-gl";
import * as images from "./images";
import { HACHIKO_COORDINATES, loadWikidata } from "./matchstations";
import { renderRoutes } from "./routes";
import * as spatial from "./spatial";
import { LocalCoordinate, azimuthalNeighbor, earthGreatCircleDistanceKm, growingHyperbolas, localDistanceKm, localDistortion, localPathIntersections, toGlobe, toLocalPlane } from "./geometry";



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

const STANDARD_WALKING_SPEED_KPH = 4.5;
const WALK_MAX_MIN = 30;
const WALK_MAX_KM = WALK_MAX_MIN * STANDARD_WALKING_SPEED_KPH * 60;
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

	const pathingTrainPolyline = [];
	const pathingWalkPolyline = [];

	type Circle = {
		coordinate: Coordinate,
		train: TrainLabel,
		radii: { timeMinutes: number, radiusKm: number }[],
		arrivalMinutes: number,
		id: number,
	};
	const circles: Circle[] = [];
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

	const areasByLine = new Map<number | null, Coordinate[][]>();
	const placedCircles = new spatial.Spatial<Circle>(12);
	const allCircles = [];
	for (const circle of circles.sort((a, b) => a.arrivalMinutes - b.arrivalMinutes)) {
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
		allCircles.push(circle);
	}

	const allArcs = [];
	for (const circle of allCircles) {
		const radius = circle.radii[circle.radii.length - 1];

		// Step by minute.
		// Find intersections with neighbors.

		const distort = localDistortion(circle.coordinate);

		const restrictingArcs: LocalCoordinate[][] = [];
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
				restrictingArcs.push(arc.map(it => toLocalPlane(distort, it)));
				allArcs.push(arc);
			}
		}

		const poly: Coordinate[] = [];
		const resolution = 36;
		const localCenter = toLocalPlane(distort, circle.coordinate);
		for (let k = 0; k <= resolution; k++) {
			const angle = k / resolution * Math.PI * 2;
			const edge: LocalCoordinate = {
				xKm: localCenter.xKm + radius.radiusKm * Math.cos(angle),
				yKm: localCenter.yKm + radius.radiusKm * Math.sin(angle),
			};
			const sweep = [localCenter, edge];
			let closestIntersection = edge;
			for (const arc of restrictingArcs) {
				for (const intersection of localPathIntersections(arc, sweep)) {
					if (localDistanceKm(closestIntersection, localCenter) > localDistanceKm(intersection, localCenter)) {
						closestIntersection = intersection;
					}
				}
			}
			poly.push(toGlobe(distort, closestIntersection));
		}

		const key = circle.train.line;
		const polys = areasByLine.get(key) || [];
		polys.push(poly);
		areasByLine.set(key, polys);
	}

	for (const [key, polys] of areasByLine) {
		const sourceID = "train-radius-" + String(key);
		map.addSource(sourceID, {
			type: "geojson",
			data: {
				type: "Feature",
				geometry: {
					type: "MultiPolygon",
					coordinates: polys.map(poly => [poly.map<[number, number]>(c => [c.lon, c.lat])]),
				},
				properties: {},
			},
		});
		map.addLayer({
			id: "train-radius-" + String(key) + "-layer",
			type: "fill",
			source: sourceID,
			layout: {},
			paint: {
				"fill-color": images.toCSSColor(matrixLineLogos[key || -1]?.color || { r: 0, g: 0, b: 0 }),
				"fill-opacity": 0.5,
				"fill-outline-color": "transparent",
			},
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
	// 		"line-width": 2,
	// 	},
	// });
}

main();
