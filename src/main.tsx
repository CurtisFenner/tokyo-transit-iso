import * as maplibregl from "maplibre-gl";
import { ClusteredLabels } from "./components/ClusteredLabels";
import { GeojsonSourcesManager } from "./components/GeojsonSourcesManager";
import { Refreshing, Stabilizing, zipKeyedMapsTotal } from "./data/data";
import { geoJSONFromRingForest, groupContainedRings } from "./data/spatial";
import * as timer from "./data/timer";
import { cleanStationName, HACHIKO_COORDINATES } from "./matchstations";
import { blendArrivals, Pathfinder } from "./pathfinding";
import { ArrivalTime, isolines } from "./search";
import { loadTransitData, TransitData } from "./transit-data";
import { searchForPlace } from "./nomin";

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

export type Origin = { coordinate: Coordinate };

async function generateInvertedIsoline(
	transitData: TransitData,
	origins: Map<Origin, number>,
	options: {
		maxWalkMinutes: number,
		maxJourneyMinutes: number,
	},
): Promise<{
	type: "Feature",
	geometry: {
		type: "MultiPolygon",
		coordinates: [lon: number, lat: number][][][],
	},
	properties: {},
}> {
	const pathfinder = new Pathfinder<Origin>(transitData, new Map([...origins.keys()].map(o => [o, o.coordinate])), {
		...options,
		trainTransferPenaltyMinutes: 3,
		transferWalkingPenaltyMinutes: 3,
	});

	const reachableFromOrigin = new Map<Origin, Map<unknown, ArrivalTime>>();
	for (const [origin, _] of origins) {
		const reachable = pathfinder.pathfindFrom(origin.coordinate);
		reachableFromOrigin.set(origin, reachable);
	}

	const reachableFromAllOrigins: Map<Origin, ArrivalTime>[] = [
		...zipKeyedMapsTotal(reachableFromOrigin)
			.values()
	];

	const blendedArrivals: ArrivalTime[] = [];
	for (const reached of reachableFromAllOrigins) {
		const blendedArrival = blendArrivals(
			new Map(
				[...reached].map(([origin, arrival]) => [arrival, origins.get(origin)!])
			)
		);
		blendedArrivals.push(blendedArrival);
	}

	const rings = await timer.timed("isolines", () => isolines(blendedArrivals, options));

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

type PlaceState = {
	coordinate: Coordinate,
	weight: number,
};

function encodePlaceState(place: PlaceState): string {
	return `${place.coordinate.lon.toFixed(6)}_${place.coordinate.lat.toFixed(6)}_w${place.weight}`;
}

function decodePlaceState(place: string): PlaceState | null {
	const match = place.match(/^([0-9.-]+)_([0-9.-]+)_w([0-9]+)$/);
	if (match === null) {
		return null;
	}
	return {
		coordinate: {
			lon: parseFloat(match[1]),
			lat: parseFloat(match[2]),
		},
		weight: parseFloat(match[3]),
	};
}

function encodePlaceStates(places: PlaceState[]): string {
	return places.map(encodePlaceState).join("..");
}

function decodePlaceStates(hash: string): PlaceState[] {
	return hash.split("..").map(decodePlaceState).filter(x => x !== null);
}

const markers: {
	state: PlaceState,
	marker: maplibregl.Marker,
}[] = [];

async function main() {
	const loadTimeline = new timer.Timeline();
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

	// Create labels for each train station.
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

	const shadelayers = new class Foo extends GeojsonSourcesManager<{ origins: PlaceState[], options: { maxWalkMinutes: number, maxJourneyMinutes: number } }> {
		constructor() {
			super(map, async (req: { origins: PlaceState[], options: { maxWalkMinutes: number, maxJourneyMinutes: number } }) => {
				const origins = new Map();
				for (const place of req.origins) {
					origins.set(place, place.weight);
				}
				return await generateInvertedIsoline(transitData, origins, req.options,);
			});
		}
	};

	const isolineValues = [30, 40, 50];

	const isolines = new Map(isolineValues.map(isolineValue => {
		const key = "iso-" + isolineValue;
		return [
			isolineValue,
			{
				minutes: isolineValue,
				key,
				sourceID: shadelayers.createSource(key),
			},
		];
	}));

	const isoSourceIDBasic = shadelayers.createSource("basic");

	map.addLayer({
		id: Math.random().toString(),
		type: "fill",
		source: isoSourceIDBasic,
		paint: {
			"fill-color": "gray",
			"fill-opacity": 0.9,
		},
	});

	map.addLayer({
		id: Math.random().toString(),
		type: "line",
		source: isoSourceIDBasic,
		layout: {
			"line-cap": "round",
			"line-join": "round",
		},
		paint: {
			"line-color": "black",
			"line-width": 3,
		},
	});

	map.addLayer({
		id: Math.random().toString(),
		type: "line",
		source: isoSourceIDBasic,
		paint: {
			"line-color": "black",
			"line-width": 8,
			"line-blur": 8,
			"line-offset": -2,
		},
	});

	for (const [_, v] of isolines) {
		map.addLayer({
			id: v.key + "-line",
			type: "line",
			source: v.sourceID,
			layout: {
				"line-cap": "round",
				"line-join": "round",
			},
			paint: {
				"line-color": "black",
				"line-width": 1.5,
				"line-opacity": 0.35,
				"line-dasharray": [2, 3],
			},
		});

		map.addLayer({
			id: v.key + "-inset-blur",
			type: "line",
			source: v.sourceID,
			paint: {
				"line-color": "black",
				"line-width": 8,
				"line-blur": 8,
				"line-offset": -2,
				"line-opacity": 0.25,
			},
		});
	}

	function rerenderIsolines() {
		const origins = markers.map(x => x.state);
		const encodedState = encodePlaceStates(origins);
		const searchParams = new URLSearchParams({
			p: encodedState,
		}).toString();
		window.history.pushState({}, "", new URL("?" + searchParams, window.location.href));

		shadelayers.recalculateSourceGeometry("basic", {
			origins,
			options: {
				maxJourneyMinutes: 60,
				maxWalkMinutes: 25,
			},
		});
		for (const [k, v] of isolines) {
			shadelayers.recalculateSourceGeometry(v.key, {
				origins,
				options: {
					maxJourneyMinutes: k,
					maxWalkMinutes: 25,
				},
			});
		}
	}

	const urlPlaceStates =
		decodePlaceStates(new URL(window.location.href).searchParams.get("p") || "");
	if (urlPlaceStates.length === 0) {
		urlPlaceStates.push({
			coordinate: HACHIKO_COORDINATES,
			weight: 1,
		});
	}

	for (const urlPlaceState of urlPlaceStates) {
		const marker = new maplibregl.Marker({ draggable: true })
			.setLngLat(urlPlaceState.coordinate)
			.addTo(map);

		marker.on("dragend", async () => {
			const selected = marker.getLngLat();
			const newCoordinate = { lat: selected.lat, lon: selected.lng };
			const me = markers.find(x => x.marker === marker);
			if (me) {
				me.state = {
					coordinate: newCoordinate,
					weight: me.state.weight,
				};
			}

			rerenderIsolines();
		});

		markers.push({
			state: urlPlaceState,
			marker,
		});
	}

	rerenderIsolines();

	console.log(loadTimeline.entries());
}

main();

const nominateResults = document.getElementById("nominate-results") as HTMLUListElement;

const nominateQueryResults = new Refreshing(
	(searchString: string) => searchForPlace(searchString),
	(placeList, searchString) => {
		nominateResults.innerHTML = "";
		if (placeList.length === 0) {
			const li = document.createElement("li");
			const i = document.createElement("i");
			i.textContent = "No results for ";
			const kbd = document.createElement("kbd");
			kbd.textContent = searchString;
			li.appendChild(i);
			li.appendChild(kbd);
			nominateResults.appendChild(li);
		} else {
			for (const place of placeList.slice(0, 5)) {
				const li = document.createElement("li");
				const b = document.createElement("b");
				const br = document.createElement("br");
				const d = document.createElement("small");
				b.textContent = place.shortName;
				d.textContent = place.fullName.trim().replace(/(?:, \d+-\d+)?, Japan$/g, "");
				li.appendChild(b);
				li.appendChild(br);
				li.appendChild(d);
				nominateResults.appendChild(li);
			}
		}
	},
);

const nominateQuery = new Stabilizing<string>(700, searchString => {
	nominateQueryResults.update(searchString);
});

const nominateInput = document.getElementById("nominate-input") as HTMLInputElement;
nominateInput.disabled = false;
nominateInput.oninput = () => {
	nominateQuery.update(nominateInput.value);
};
