import * as maplibregl from "maplibre-gl";
import { HACHIKO_COORDINATES } from "./matchstations";
import { STANDARD_WALKING_SPEED_KPH, earthGreatCircleDistanceKm } from "./geometry";
import { printTimeTree, timed } from "./timer";
import * as nomin from "./nomin";
import ReactDOM from "react-dom/client";
import React from "react";
import { PlaceList, Waiting } from "./components/place-list";
import { StationOffset, WalkingLocus, findPathsThroughTrains, isolines } from "./search";
import { geoJSONFromRingForest, groupContainedRings } from "./spatial";
import { transit30Promise, TransitData } from "./transit-data";
import { IsoShadeLayer } from "./components/isoshadelayer";


function sleep(ms: number): Promise<number> {
	const before = performance.now();
	return new Promise(resolve => {
		setTimeout(() => {
			const after = performance.now();
			resolve(after - before);
		}, ms);
	});
}

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
	maxZoom: 17,
});
map.addControl(new maplibregl.AttributionControl(), "bottom-left");

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
	for (const [stationOffset, matrixStation] of transitData.walkingData.stationCoordinates) {
		const walkingHours = earthGreatCircleDistanceKm(source, matrixStation.coordinate) / STANDARD_WALKING_SPEED_KPH;
		const walkingMinutes = walkingHours * 60;
		if (walkingMinutes < Math.min(options.maxWalkMinutes, options.maxJourneyMinutes)) {
			walkableFromSource.set(stationOffset, walkingMinutes);
		}
	}

	const reachedList = await findPathsThroughTrains(
		transitData.trainOutEdges,
		transitData.walkingData.matrix,
		walkableFromSource,
	);
	for (const [stationOffset, path] of reachedList) {
		if (path.parent !== null && path.edge.via === "train") {
			const minutesRemainingAfterArrival = Math.max(0, options.maxJourneyMinutes - path.distance);
			circles.push({
				coordinate: transitData.walkingData.stationCoordinates.get(stationOffset)!.coordinate,
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
): Promise<{
	type: "Feature",
	geometry: {
		type: "MultiPolygon",
		coordinates: [number, number][][][],
	},
	properties: {},
}> {
	const circles = await reachableCirclesFrom(transitData, source, options);
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
	await new Promise(resolve => {
		map.on("load", () => {
			resolve(0);
		})
	});

	const shadelayers = new IsoShadeLayer(map, async (req: { coordinate: Coordinate, options: { maxWalkMinutes: number, maxJourneyMinutes: number } }) => {
		const iso = await generateInvertedIsoline(
			await transit30Promise,
			req.coordinate,
			req.options,
		);
		return iso;
	});

	ReactDOM.createRoot(document.getElementById("root")!).render(
		<React.StrictMode>
			<Waiting
				promise={transit30Promise}
				waiting=<i>Loading transit data...</i>
				failed={e => <></>}>
				{transitData => {
					return <PlaceList
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
				}}
			</Waiting>
		</React.StrictMode>
	);
}

main();
