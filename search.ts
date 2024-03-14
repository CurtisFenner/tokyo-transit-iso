type Coordinate = { lat: number, lon: number };

type MatrixTrainLabel = {
	service: string,
	destination: string | null,
	line: number,
};

type MatrixTime = {
	to: number,
	minutes: number;
	services: {
		effectiveInterval: number;
		expectedWaitAndTransit: number;
		trainService: MatrixTrainLabel;
	}[],
};

type Matrix = {
	embarkMinutes: [number, number],
	times: MatrixTime[][],
};

type MatrixStation = {
	name: string,
	kana: string,
	coordinate: Coordinate | null,
};

type MatrixLine = {
	name: string,
	stops: number[],
	en: string | undefined, logo?: string, logo2?: string,
};

/**
 * This is the type of `generated/matrix.json`.
 */
type Matrices = {
	stations: MatrixStation[],
	lines: MatrixLine[],
	matrices: Matrix[],
};

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
L.tileLayer(
	"https://a.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png", {
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
	const f = await fetch("generated/matrix.json.gz");
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

function dijkstras(trainMatrix: Matrix, walkingMatrix: [StationOffset, number][][], stationOffset: StationOffset, matrices: Matrices) {
	const trainPenaltyMinutes = 3;
	const walkPenaltyMinutes = 1;

	const searchLog = [];

	const visited: {
		time: number,
		parent: null
		| { via: "walk", from: StationOffset }
		| { via: "train", train: MatrixTrainLabel[], from: StationOffset },
	}[] = [];
	visited[stationOffset] = { time: 0, parent: null };
	const queue = [{ stationOffset, time: 0 }];
	while (queue.length > 0) {
		queue.sort((a, b) => b.time - a.time);
		const top = queue.pop()!;
		searchLog.push(top);

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

		for (const neighbor of trainMatrix.times[top.stationOffset]) {
			if (!neighbor.minutes) {
				// A null or 0 should be ignored.
				continue;
			}

			const arrivalStationOffset = neighbor.to;
			const arrivalTime = top.time + neighbor.minutes + trainPenaltyMinutes;
			if (!visited[arrivalStationOffset] || visited[arrivalStationOffset].time > arrivalTime) {
				visited[arrivalStationOffset] = {
					parent: {
						via: "train",
						train: neighbor.services.map(x => x.trainService),
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

function pluralize(count: number, singular: string, plural = singular + "s") {
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

async function main() {
	const matrices = await loadMatrices();

	const wikidata = await loadWikidata();

	const logoAtlasRectangles = await fetchLogoAtlasRectangles();
	const logoAtlas = await new Promise<HTMLImageElement>((resolve, reject) => {
		const img = document.createElement("img");
		img.src = "wikidata/logos.png";
		img.onload = () => resolve(img);
		img.onerror = reject;
	});

	console.log(matrices);

	const wikiStations: (WikidataStation | null)[] = [];
	for (const station of matrices.stations) {
		if (!station.coordinate) {
			console.error("missing coordinate:", station);
			continue;
		}

		const nearby = wikidata.nearbyStation(station, { radiusKm: 4 });
		wikiStations.push(nearby);
	}

	const lineColors: Color[] = [];
	const lineLogos: (string | null)[] = [];
	const wikiLines = [];
	for (const line of matrices.lines) {
		const match = wikidata.matchLine(
			line,
			line.stops.map(stop => wikiStations[stop]).filter(x => x) as WikidataStation[],
		);
		wikiLines.push(match);

		const logoRectangle = logoAtlasRectangles[match?.qID || ""];
		if (logoRectangle) {
			const canvas = document.createElement("canvas");
			canvas.width = logoRectangle.right - logoRectangle.left;
			canvas.height = logoRectangle.bottom - logoRectangle.top;
			const ctx = canvas.getContext("2d")!;
			ctx.drawImage(logoAtlas, -logoRectangle.left, -logoRectangle.top);
			const src = canvas.toDataURL();
			const img = await imagePromise(src);
			lineColors.push(await getImageColor(img));
			lineLogos.push(img.src);
		} else {
			lineColors.push({ r: 102, g: 102, b: 102 });
			lineLogos.push(null);
		}
	}

	console.log("matched lines:", wikiLines.filter(x => x).length, "/", matrices.lines.length);

	const before = performance.now();
	const walking = walkingMatrix(matrices);
	const after = performance.now();
	console.log(after - before, "ms calculating walking:", walking);

	const SHIBUYA = matrices.stations.findIndex(x => x.name.includes("渋谷"))!;
	const beforeDijkstras = performance.now();

	const reachable = dijkstras(matrices.matrices[0], walking, SHIBUYA, matrices)
		.map((v, i) => ({ ...v, i }));
	const afterDijkstras = performance.now();
	console.log(afterDijkstras - beforeDijkstras, "ms searching");

	console.log("FROM SHIBUYA:", reachable);
	const table = document.createElement("table");
	for (const v of reachable.filter(x => x).sort((a, b) => a.time - b.time)) {
		if (v.time) {
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
				const station = document.createElement("span");
				station.className = "station";
				station.textContent = matrices.stations[node.i].name + " @ " + formatTime(node.time);
				routeTd.prepend(station);

				if (!node.parent) {
					break;
				}
				if (node.parent.via === "train") {
					const trainDescription = node.parent.train[0];
					const trainSpan = document.createElement("span");
					trainSpan.className = "train";

					let logoUrl = null;

					if (!trainDescription) {
						trainSpan.textContent = ("ERROR");
					} else {
						const lineName = matrices.lines[trainDescription.line].name;
						const serviceName = trainDescription.service;

						trainSpan.textContent = lineName + " [" + serviceName + "]";

						logoUrl = lineLogos[trainDescription.line];
					}
					trainSpan.style.background = toCSSColor(lineColors[trainDescription.line]);
					trainSpan.style.color = contrastingColor(lineColors[trainDescription.line]);
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

	document.getElementById("panel")!.appendChild(table);
}

main();
