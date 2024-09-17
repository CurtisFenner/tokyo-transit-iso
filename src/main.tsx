import * as maplibregl from "maplibre-gl";
import { cleanStationName, HACHIKO_COORDINATES } from "./matchstations";
import { STANDARD_WALKING_SPEED_KPH, earthGreatCircleDistanceKm } from "./geometry";
import { printTimeTree, timed } from "./timer";
import * as nomin from "./nomin";
import ReactDOM from "react-dom/client";
import React from "react";
import { PlaceList, Waiting } from "./components/place-list";
import { StationOffset, WalkingLocus, findPathsThroughTrains, isolines, loadMatrices } from "./search";
import { geoJSONFromRingForest, groupContainedRings } from "./spatial";
import { transit30Promise, TransitData } from "./transit-data";
import { IsoShadeLayer } from "./components/isoshadelayer";
import { watchClusters } from "./map-helper";


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

const TOKYO_CENTER = {
	lat: (TOKYO_BOUNDS[0].lat + TOKYO_BOUNDS[1].lat) / 2,
	lon: (TOKYO_BOUNDS[0].lng + TOKYO_BOUNDS[1].lng) / 2,
};

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
	await new Promise(resolve => {
		map.on("load", () => {
			resolve(0);
		})
	});

	const shadelayers = new IsoShadeLayer(map, async (req: { coordinate: Coordinate, options: { maxWalkMinutes: number, maxJourneyMinutes: number } }) => {
		const iso = await generateInvertedIsoline(
			await transit30Promise,
			[
				req,
			],
			req.options,
		);
		return iso;
	});

	const stationLabelsFeatures: {
		type: "FeatureCollection",
		features: {
			type: "Feature",
			properties: object,
			geometry: {
				type: "Point",
				coordinates: [number, number],
			},
		}[],
	} = {
		type: "FeatureCollection",
		features: [],
	};

	type StationLabelProperties = {
		nameJa: string,
		lineCount: number,
		lat: number,
		lon: number,
		index: number,
	};

	const matrices = await loadMatrices();
	for (let stationIndex = 0; stationIndex < matrices.stations.length; stationIndex++) {
		const matrixStation = matrices.stations[stationIndex];
		const nameJa = cleanStationName(matrixStation.name);
		const coordinate = matrixStation.coordinate;
		const lineCount = matrices.lines.filter(x => x.stops.includes(stationIndex)).length;

		stationLabelsFeatures.features.push({
			type: "Feature",
			properties: {
				nameJa,
				lineCount,
				lat: coordinate.lat,
				lon: coordinate.lon,
				index: stationIndex,
			} satisfies StationLabelProperties,
			geometry: {
				type: "Point",
				coordinates: [coordinate.lon, coordinate.lat],
			},
		});
	}

	map.addSource("station_names", {
		type: "geojson",
		data: stationLabelsFeatures,
		cluster: true,
		clusterRadius: 35,
	});

	map.addLayer({
		'id': 'earthquake_circle_true',
		'type': 'circle',
		'source': 'station_names',
		paint: { "circle-radius": 0 },
	});

	const previouslyRendered = new Map<StationOffset, { marker: maplibregl.Marker, added: boolean }>();
	function rerenderChosenLabels(selected: StationLabelProperties[]) {
		let counts = {
			fresh: 0,
			added: 0,
			removed: 0,
		};

		const selectedSet = new Set<StationOffset>();
		for (const label of selected) {
			if (label.lineCount === 1 && map.getZoom() < 12) {
				// Skip non-transfer stations when not zoomed in.
				continue;
			}
			selectedSet.add(label.index);
			let previous = previouslyRendered.get(label.index);
			if (!previous) {
				const element = document.createElement("div");
				const word = document.createElement("div");
				word.className = "train-station-label unclickable";
				word.textContent = label.nameJa;
				element.appendChild(word);
				const marker = new maplibregl.Marker({
					draggable: false,
					element,
					className: "unclickable",
				}).setLngLat(label);

				previous = {
					added: false,
					marker,
				};
				previouslyRendered.set(label.index, previous);

				counts.fresh += 1;
			}

			if (!previous.added) {
				counts.added += 1;
				previous.marker.addTo(map);
				previous.added = true;
			}
		}

		for (const [k, v] of previouslyRendered) {
			if (v.added && !selectedSet.has(k)) {
				v.marker.remove();
				v.added = false;
				counts.removed += 1;
			}
		}
	}

	watchClusters(map, "station_names", {
		limit: 150,
		debounceMs: 350,
	}, clusters => {
		const selected = [];
		for (const cluster of clusters as StationLabelProperties[][]) {
			let best = cluster[0];
			for (let i = 1; i < cluster.length; i++) {
				if (cluster[i].lineCount > best.lineCount) {
					best = cluster[i];
				} else if (cluster[i].lineCount === best.lineCount) {
					if (earthGreatCircleDistanceKm(TOKYO_CENTER, best) > earthGreatCircleDistanceKm(TOKYO_CENTER, cluster[i])) {
						best = cluster[i];
					}
				}
			}

			selected.push(best);
		}

		rerenderChosenLabels(selected);
	});

	ReactDOM.createRoot(document.getElementById("root")!).render(
		<React.StrictMode>
			<Waiting
				promise={transit30Promise}
				waiting=<i>Loading transit data...</i>
				failed={e => <></>}>
				{transitData => {
					return <>
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
					</>;
				}}
			</Waiting>
		</React.StrictMode>
	);
}

main();
