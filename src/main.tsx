import * as maplibregl from "maplibre-gl";
import * as images from "./images";
import { HACHIKO_COORDINATES, loadWikidata } from "./matchstations";
import { STANDARD_WALKING_SPEED_KPH } from "./geometry";
import { printTimeTree, timed } from "./timer";
import * as nomin from "./nomin";
import ReactDOM from "react-dom/client";
import React from "react";
import { PlaceList } from "./components/place-list";
import { WalkingLocus, addGridRegions, findPathsThroughTrains, isolines, loadMatrices, looped, toLonLat, walkingMatrix } from "./search";


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

const map = new maplibregl.Map({
	container: document.getElementById("map")!,
	style: 'maplibre-style.json',
	center: [HACHIKO_COORDINATES.lon, HACHIKO_COORDINATES.lat],
	zoom: 9,
	attributionControl: false,
});
map.addControl(new maplibregl.AttributionControl(), "bottom-left");

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

	await addGridRegions(map, matrixLineLogos, circles, options);

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

main();
