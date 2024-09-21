import * as maplibregl from "maplibre-gl";
import { cleanStationName, HACHIKO_COORDINATES } from "./matchstations";
import { STANDARD_WALKING_SPEED_KPH, earthGreatCircleDistanceKm } from "./geometry";
import { printTimeTree, timed, Timeline } from "./timer";
import * as nomin from "./nomin";
import ReactDOM from "react-dom/client";
import React from "react";
import { PlaceList, Waiting } from "./components/place-list";
import { StationOffset, WalkingLocus, findPathsThroughTrains, isolines, loadMatrices } from "./search";
import { geoJSONFromRingForest, groupContainedRings } from "./spatial";
import { loadTransitData, TransitData } from "./transit-data";
import { IsoShadeLayer } from "./components/isoshadelayer";
import { watchClusters } from "./map-helper";
import { ClusteredLabels } from "./components/ClusteredLabels";

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

const TOKYO_CENTER = Object.freeze({
	lat: (TOKYO_BOUNDS[0].lat + TOKYO_BOUNDS[1].lat) / 2,
	lon: (TOKYO_BOUNDS[0].lng + TOKYO_BOUNDS[1].lng) / 2,
});

const TOKYO_BOUNDS_MARGIN: [{ lng: number, lat: number }, { lng: number, lat: number }] = [
	Object.freeze({
		"lng": 138.0548457793563 - 0.5,
		"lat": 34.82749433255117 - 0.25,
	}),
	Object.freeze({
		"lng": 142.06704277877105 + 0.5,
		"lat": 36.43245961371258 + 0.25,
	}),
];

const map = new maplibregl.Map({
	container: document.getElementById("map")!,
	style: 'maplibre-style.json',
	center: [HACHIKO_COORDINATES.lon, HACHIKO_COORDINATES.lat],
	zoom: 9,
	attributionControl: false,
	maxBounds: TOKYO_BOUNDS,
	maxZoom: 17,
}).addControl(new maplibregl.AttributionControl(), "bottom-left");

map.touchZoomRotate.disableRotation();
map.keyboard.disableRotation();
map.dragRotate.disable();

for (const collapser of document.body.getElementsByClassName("collapser")) {
	if (!(collapser instanceof HTMLButtonElement)) {
		throw new Error("collapser class should only be applied to buttons");
	}

	let collapsed = false;
	collapser.onclick = () => {
		collapsed = !collapsed;
		if (collapsed) {
			collapser.parentElement!.style.right = "calc(-3rem - var(--full-width))";
			collapser.style.transform = "rotate(180deg)";
		} else {
			collapser.parentElement!.style.right = "0px";
			collapser.style.transform = "rotate(0deg)";
		}
	};

	collapser.disabled = false;
}

async function reachableCirclesFrom(
	transitData: TransitData,
	source: Coordinate,
	options: {
		maxWalkMinutes: number,
		maxJourneyMinutes: number,
	},
): Promise<Map<`initial${number}` | StationOffset, WalkingLocus>> {
	const circles = new Map<`initial${number}` | StationOffset, WalkingLocus>();
	circles.set("initial0", {
		coordinate: source,
		arrivalMinutes: 0,
	});

	const walkableFromSource = new Map<StationOffset, number>();
	for (const [stationOffset, matrixStation] of transitData.walkingData.stationCoordinates) {
		const walkingHours = earthGreatCircleDistanceKm(source, matrixStation.coordinate) / STANDARD_WALKING_SPEED_KPH;
		const walkingMinutes = walkingHours * 60;
		if (walkingMinutes < Math.min(options.maxWalkMinutes, options.maxJourneyMinutes)) {
			walkableFromSource.set(stationOffset, walkingMinutes);
		}
	}

	const reachedList = findPathsThroughTrains(
		transitData.trainOutEdges,
		transitData.walkingData.matrix,
		walkableFromSource,
	);
	for (const [stationOffset, path] of reachedList) {
		if (path.parent !== null && path.edge.via === "train") {
			circles.set(stationOffset, {
				coordinate: transitData.walkingData.stationCoordinates.get(stationOffset)!.coordinate,
				arrivalMinutes: path.distance,
			});
		}
	}

	return circles;
}

function mergeCircles(circlesBySource: Map<string | StationOffset, WalkingLocus>[]): Map<string | StationOffset, WalkingLocus> {
	const nonEmpty = circlesBySource.filter(x => x.size !== 0);
	if (nonEmpty.length === 1) {
		return nonEmpty[0];
	} else if (nonEmpty.length === 0) {
		return new Map();
	}

	const grouped = new Map<StationOffset, WalkingLocus[]>();
	for (const circles of circlesBySource) {
		for (const [ref, circle] of circles) {
			if (typeof ref !== "string") {
				grouped.set(ref, grouped.get(ref) || []);
				grouped.get(ref)!.push(circle);
			}
		}
	}

	const blended = new Map<StationOffset, WalkingLocus>();
	for (const [ref, group] of grouped) {
		if (group.length !== nonEmpty.length) {
			continue;
		}

		let sumOfSquares = 0;
		for (const v of group) {
			sumOfSquares += v.arrivalMinutes ** 2;
		}

		sumOfSquares /= group.length;
		const blendedArrivalMinutes = Math.sqrt(sumOfSquares);
		blended.set(ref, {
			coordinate: group[0].coordinate,
			arrivalMinutes: blendedArrivalMinutes,
		});
	}
	return blended;
}

async function generateInvertedIsoline(
	transitData: TransitData,
	sources: { coordinate: Coordinate }[],
	options: {
		maxWalkMinutes: number,
		maxJourneyMinutes: number,
	},
): Promise<{
	type: "Feature",
	geometry: {
		type: "MultiPolygon",
		coordinates: [number, number][][][],
	},
	properties: {},
}> {
	const circlesBySource = await Promise.all(sources.map(source => {
		return reachableCirclesFrom(transitData, source.coordinate, options);
	}));

	const circles = mergeCircles(circlesBySource);

	const rings = await timed("isolines", () => isolines([...circles.values()], options.maxJourneyMinutes, options));

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
	const loadTimeline = new Timeline();
	const mapLoad = loadTimeline.start("load map");
	const transitDataLoad = loadTimeline.start("load transit data");

	const transit30Promise = loadTransitData({ maxWalkMinutes: 60 });

	await new Promise(resolve => {
		map.on("load", () => {
			loadTimeline.finish(mapLoad, null);
			resolve(0);
		});
	});

	const transitData = await transit30Promise;
	loadTimeline.finish(transitDataLoad, null);

	const shadelayers = new IsoShadeLayer(map, async (req: { coordinate: Coordinate, options: { maxWalkMinutes: number, maxJourneyMinutes: number } }) => {
		const iso = await generateInvertedIsoline(
			transitData,
			[
				req,
			],
			req.options,
		);
		return iso;
	});

	new ClusteredLabels(map,
		transitData.stations.map((station, stationIndex) => {
			const lines = transitData.lines.filter(line => {
				return line.stops.includes(stationIndex);
			}).length;
			const terminus = transitData.lines.filter(line => {
				return line.stops[0] === stationIndex || line.stops[line.stops.length - 1] === stationIndex;
			}).length;

			const priority = lines + terminus * 0.1;
			return {
				data: { ...station, lines, terminus, priority },
				priority,
				minZoom: (lines <= 1 && terminus === 0)
					? 13
					: (lines + terminus * 0.55 <= 2
						? 10.6
						: 0),
				coordinate: station.coordinate,
			};
		}),
		{
			clusterRadius: 35,
			makeMarker(d: MatrixStation): maplibregl.Marker {
				const element = document.createElement("div");
				const word = document.createElement("div");
				word.className = "train-station-label unclickable";
				word.textContent = cleanStationName(d.name);
				element.appendChild(word);
				return new maplibregl.Marker({
					draggable: false,
					element,
					className: "unclickable",
				});
			},
		});

	ReactDOM.createRoot(document.getElementById("root")!).render(
		<React.StrictMode>
			<PlaceList
				isoshade={shadelayers}
				transitData={transitData}
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

	console.log(loadTimeline.entries());
}

main();
