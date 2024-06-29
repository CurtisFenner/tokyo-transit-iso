import * as maplibregl from "maplibre-gl";
import * as images from "./images";
import { HACHIKO_COORDINATES, loadWikidata } from "./matchstations";
import { STANDARD_WALKING_SPEED_KPH, earthGreatCircleDistanceKm } from "./geometry";
import { printTimeTree, timed } from "./timer";
import * as nomin from "./nomin";
import ReactDOM from "react-dom/client";
import React from "react";
import { PlaceList } from "./components/place-list";
import { StationOffset, WalkingLocus, findPathsThroughTrains, isolines, loadMatrices, looped, toLonLat, walkingMatrix } from "./search";
import { geoJSONFromRingForest, groupContainedRings } from "./spatial";


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

const TOKYO_BOUNDS: [{ lng: number, lat: number }, { lng: number, lat: number }] = [
	Object.freeze({
		"lng": 138.0548457793563,
		"lat": 34.82749433255117,
	}),
	Object.freeze({
		"lng": 142.06704277877105,
		"lat": 36.43245961371258,
	}),
];

const TOKYO_BOUNDS_MARGIN: [{ lng: number, lat: number }, { lng: number, lat: number }] = [
	Object.freeze({
		"lng": 138.0548457793563 - 0.25,
		"lat": 34.82749433255117 - 0.125,
	}),
	Object.freeze({
		"lng": 142.06704277877105 + 0.25,
		"lat": 36.43245961371258 + 0.125,
	}),
];

const map = new maplibregl.Map({
	container: document.getElementById("map")!,
	style: 'maplibre-style.json',
	center: [HACHIKO_COORDINATES.lon, HACHIKO_COORDINATES.lat],
	zoom: 9,
	attributionControl: false,
	maxBounds: TOKYO_BOUNDS,
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

const sourceMarker = new maplibregl.Marker({ draggable: true })
	.setLngLat(HACHIKO_COORDINATES)
	.addTo(map);

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

type TransitData = {
	trainOutEdges: MatrixDistance[][],
	walkingOutEdges: { to: StationOffset, minutes: number }[][],
	stationCoordinates: Map<StationOffset, Coordinate>,
};

async function reachableCirclesFrom(
	transitData: TransitData,
	source: Coordinate,
	options: {
		maxWalkMinutes: number,
		maxJourneyMinutes: number,
	},
): Promise<WalkingLocus[]> {
	const circles: WalkingLocus[] = [
		{
			coordinate: source,
			radiusKm: Math.min(options.maxWalkMinutes, options.maxJourneyMinutes)
				* STANDARD_WALKING_SPEED_KPH / 60,
			arrivalMinutes: 0,
		},
	];

	const walkableFromSource = new Map<StationOffset, number>();
	for (const [stationOffset, coordinate] of transitData.stationCoordinates) {
		const walkingHours = earthGreatCircleDistanceKm(source, coordinate) / STANDARD_WALKING_SPEED_KPH;
		const walkingMinutes = walkingHours * 60;
		if (walkingMinutes < Math.min(options.maxWalkMinutes, options.maxJourneyMinutes)) {
			walkableFromSource.set(stationOffset, walkingMinutes);
		}
	}

	const reachedList = await findPathsThroughTrains(
		transitData.trainOutEdges,
		transitData.walkingOutEdges,
		walkableFromSource,
	);
	for (const [stationOffset, path] of reachedList) {
		if (path.parent !== null && path.edge.via === "train") {
			const minutesRemainingAfterArrival = Math.max(0, options.maxJourneyMinutes - path.distance);
			circles.push({
				coordinate: transitData.stationCoordinates.get(stationOffset)!,
				radiusKm: Math.min(
					options.maxWalkMinutes,
					minutesRemainingAfterArrival,
				) * (STANDARD_WALKING_SPEED_KPH / 60),
				arrivalMinutes: path.distance,
			});
		}
	}

	return circles;
}

async function generateInvertedIsoline(
	transitData: TransitData,
	source: Coordinate,
	options: {
		maxWalkMinutes: number,
		maxJourneyMinutes: number,
	},
) {
	const circles = await reachableCirclesFrom(transitData, source, options);

	await sleep(60);
	loadingMessage.textContent = "Rendering map...";
	await sleep(60);

	const rings = await timed("isolines", () => isolines(circles, options.maxJourneyMinutes, options));

	const geojson = geoJSONFromRingForest(
		groupContainedRings(
			[
				[
					{ lon: TOKYO_BOUNDS_MARGIN[0].lng, lat: TOKYO_BOUNDS_MARGIN[0].lat },
					{ lon: TOKYO_BOUNDS_MARGIN[1].lng, lat: TOKYO_BOUNDS_MARGIN[0].lat },
					{ lon: TOKYO_BOUNDS_MARGIN[1].lng, lat: TOKYO_BOUNDS_MARGIN[1].lat },
					{ lon: TOKYO_BOUNDS_MARGIN[0].lng, lat: TOKYO_BOUNDS_MARGIN[1].lat },

				],
				...rings.boundaries,
			]
		)
	);

	return geojson;
}

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

	const transitData: TransitData = {
		trainOutEdges: matrices.matrices[0].distances,
		walkingOutEdges: walking,
		stationCoordinates: new Map(
			matrices.stations.map((x, i) => [i, x.coordinate]),
		),
	};

	const originalGeojson = await generateInvertedIsoline(
		transitData,
		HACHIKO_COORDINATES,
		options,
	);

	map.addSource("isolines-all", {
		type: "geojson",
		lineMetrics: true,
		data: originalGeojson,
	});

	sourceMarker.on("dragend", async () => {
		const selected = sourceMarker.getLngLat();
		const source = map.getSource("isolines-all") as maplibregl.GeoJSONSource;
		const newGeoJSON = await generateInvertedIsoline(
			transitData,
			{ lat: selected.lat, lon: selected.lng },
			options,
		);
		source.setData(newGeoJSON);
	});

	map.addLayer({
		id: "isolines-fill",
		type: "fill",
		source: "isolines-all",
		paint: {
			"fill-color": "gray",
			"fill-opacity": 0.5,
		},
	});

	map.addLayer({
		id: "isolines-polyline",
		type: "line",
		source: "isolines-all",
		paint: {
			"line-color": "black",
			"line-width": 3,
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
