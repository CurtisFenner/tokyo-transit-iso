function toSpherical(coordinate: Coordinate) {
	const latRad = Math.PI * 2 * coordinate.lat / 360;
	const lonRad = Math.PI * 2 * coordinate.lon / 360;
	return {
		x: Math.cos(lonRad) * Math.cos(latRad),
		y: Math.sin(lonRad) * Math.cos(latRad),
		z: Math.sin(latRad),
	};
}

function earthGreatCircleDistanceKm(a: Coordinate, b: Coordinate) {
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

const map = L.map('map', {
	attributionControl: false,
}).setView([35.662, 139.724], 13);
L.tileLayer("https://a.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png", {
	maxZoom: 19,
}).addTo(map);

L.control.attribution({
	position: "bottomleft",
	prefix: [
		'&copy; <a href="https://openmaptiles.org/" target="_blank">OpenMapTiles</a>',
		'&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>',
	].join(" ")
}).addTo(map);

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
	let count = 0;

	const walkingTransfers: [StationOffset, number][][] = [];
	for (let i = 0; i < matrices.stations.length; i++) {
		walkingTransfers[i] = [];
	}

	for (let from = 0; from < matrices.stations.length; from++) {
		const fromStation = matrices.stations[from];
		if (!fromStation.coordinate) continue;

		for (let to = 0; to < from; to++) {
			const toStation = matrices.stations[to];
			if (!toStation.coordinate) continue;

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

function dijkstras(
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

function formatTime(time: number): string {
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

	const lineLogos = await loadLineLogos();

	await sleep(60);
	loadingMessage.textContent = "Calculating walking distances...";
	await sleep(60);

	const before = performance.now();
	const walking = walkingMatrix(matrices);
	const after = performance.now();
	console.log(after - before, "ms calculating walking:", walking);

	await sleep(60);
	loadingMessage.textContent = "Calculating travel times...";
	await sleep(60);

	const SHIBUYA = matrices.stations.findIndex(x => x.name.includes("渋谷"))!;
	const beforeDijkstras = performance.now();

	const reachable = dijkstras(matrices.matrices[0], walking, SHIBUYA, matrices)
		.map((v, i) => ({ ...v, i }));
	const afterDijkstras = performance.now();
	console.log(afterDijkstras - beforeDijkstras, "ms searching");

	console.log("FROM SHIBUYA:", reachable);
	const table = document.createElement("table");
	for (const v of reachable.filter(x => x).sort((a, b) => a.time - b.time)) {
		if (v.time && v.time < 60 * 2.5) {
			const i = v.i;
			const row = document.createElement("tr");
			const th = document.createElement("th");
			const station = matrices.stations[i];
			th.textContent = station.name;
			row.appendChild(th);
			const timeTd = document.createElement("td");
			timeTd.textContent = formatTime(v.time);
			row.appendChild(timeTd);
			const routeTd = document.createElement("td");
			let node = v;
			let iterations = 0;
			while (node) {
				routeTd.prepend(document.createTextNode("@ " + formatTime(node.time)));
				const station = document.createElement("span");
				station.textContent = matrices.stations[node.i].name;
				station.className = "station";
				routeTd.prepend(station);

				if (!node.parent) {
					break;
				}
				if (node.parent.via === "train") {
					const trainDescription = node.parent.train.route[0];
					const trainSpan = document.createElement("span");
					trainSpan.className = "train";

					let logoUrl = null;

					if (!trainDescription) {
						trainSpan.textContent = ("ERROR");
					} else {
						trainSpan.setAttribute("data-train-route", JSON.stringify(node.parent.train.route));
						const trainLine = matrices.lines[trainDescription.line || -1]
						const lineName = trainLine?.name;
						if (trainLine) {
							const wikiLine = wikidata.matchedLines.get(trainLine);
							if (wikiLine) {
								const lineLogo = lineLogos.get(wikiLine.qID);
								if (lineLogo) {
									trainSpan.style.backgroundColor = toCSSColor(lineLogo.color);
									trainSpan.style.color = contrastingColor(lineLogo.color);
								}
							}
						}
						const serviceName = trainDescription.service;

						trainSpan.textContent = lineName + (
							serviceName
								? " [" + serviceName + "]"
								: "");

						logoUrl = null;
					}
					routeTd.prepend(trainSpan);

					if (logoUrl) {
						const img = document.createElement("img");
						img.className = "inline-logo";
						img.src = logoUrl;
						routeTd.prepend(" ");
						routeTd.prepend(img);
					}
				} else {
					routeTd.prepend("walk");
				}

				node = reachable[node.parent.from];

				iterations += 1;
				if (iterations > 100) {
					throw new Error("excessive iterations!");
				}
			}
			row.appendChild(routeTd);
			table.appendChild(row);
		}
	}

	loadingMessage.textContent = "";

	document.getElementById("panel")!.appendChild(table);

	const stationIcon = L.icon({
		iconUrl: "dot.png",
		iconSize: [32, 32],
		shadowUrl: "dot-shadow.png",
		shadowSize: [32, 32],
	});

	const walkLineOptions: L.PolylineOptions = {
		dashArray: "4 8",
	};
	const trainLineOptions: L.PolylineOptions = {
	};

	for (const reached of reachable.filter(x => x.time < 60 * 4.5)) {
		const station = matrices.stations[reached.i];

		L.marker([station.coordinate.lat, station.coordinate.lon], { icon: stationIcon })
			.addTo(map)
			.bindTooltip(station.name + " in " + pluralize(Math.round(reached.time), "minute"));

		const parent = reached.parent;
		if (parent) {
			const parentStation = matrices.stations[parent.from];
			if (parent?.via === "train") {
				const line: [number, number][] = [];
				for (const stop of parent.train.route) {
					const viaStation = matrices.stations[stop.departing];
					line.push([viaStation.coordinate.lat, viaStation.coordinate.lon]);
				}
				line.push([station.coordinate.lat, station.coordinate.lon]);
				L.polyline(line, trainLineOptions)
					.addTo(map);
			} else if (parent?.via === "walk") {
				const line: [number, number][] = [
					[station.coordinate.lat, station.coordinate.lon],
					[parentStation.coordinate.lat, parentStation.coordinate.lon],
				];
				L.polyline(line, walkLineOptions)
					.addTo(map);
			}
		}
	}
}

main();
