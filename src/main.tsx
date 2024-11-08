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
import { earthGreatCircleDistanceKm } from "./geometry";

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

function collapsibleAbove(e: HTMLElement): HTMLElement {
	if (e.classList.contains("collapsible")) {
		return e;
	} else if (!e.parentElement) {
		throw new Error("collapser does not have a .collapsible ancestor");
	} else {
		return collapsibleAbove(e.parentElement);
	}
}

for (const collapser of document.body.getElementsByClassName("collapser")) {
	if (!(collapser instanceof HTMLButtonElement)) {
		throw new Error("collapser class should only be applied to buttons");
	}
	collapser.onclick = () => {
		const collapsible = collapsibleAbove(collapser);
		collapsible.classList.toggle("collapsed");
	};
	collapser.disabled = false;
}

export type Origin = { coordinate: Coordinate };

async function generateInvertedIsolines(
	transitData: TransitData,
	origins: Map<Origin, number>,
	options: {
		maxWalkMinutes: number,
		maxJourneyMinutes: number[],
	},
): Promise<{
	type: "Feature",
	geometry: {
		type: "MultiPolygon",
		coordinates: [lon: number, lat: number][][][],
	},
	properties: {},
}> {
	const coordinates = [];
	for (const max of options.maxJourneyMinutes) {
		const line = await generateInvertedIsoline(transitData, origins, {
			maxWalkMinutes: options.maxWalkMinutes,
			maxJourneyMinutes: max,
		});
		coordinates.push(...line.geometry.coordinates);
	}

	return {
		type: "Feature",
		geometry: {
			type: "MultiPolygon",
			coordinates,
		},
		properties: [],
	};
}

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
	title: string,
	coordinate: Coordinate,
	weight: number,
};

function encodePlaceState(place: PlaceState): string {
	return `${place.coordinate.lon.toFixed(6)}_${place.coordinate.lat.toFixed(6)}_w${place.weight}_t${place.title}`;
}

function decodePlaceState(place: string): PlaceState | null {
	const match = place.match(/^([0-9.-]+)_([0-9.-]+)_w([0-9]+)_t(.*)$/);
	if (match === null) {
		return null;
	}
	const [_, lonStr, latStr, weightStr, titleStr] = match;
	return {
		coordinate: {
			lon: parseFloat(lonStr),
			lat: parseFloat(latStr),
		},
		weight: parseFloat(weightStr),
		title: titleStr,
	};
}

const markers: {
	state: PlaceState,
	marker: maplibregl.Marker,
	/**
	 * The container in the "place-list-div" element.
	 */
	row: HTMLElement,
}[] = [];

const placeListDiv = document.getElementById("place-list-div")!;
const settingsMaxCommuteInput = document.getElementById("settings-max-commute-input") as HTMLInputElement;
const settingsWalkInput = document.getElementById("settings-walk-input") as HTMLInputElement;

function addPlaceToState(
	state: PlaceState,
	rerender: (mode?: "cheap") => void,
): void {
	const marker = new maplibregl.Marker({ draggable: true })
		.setLngLat(state.coordinate)
		.addTo(map);

	marker.on("dragend", async () => {
		const selected = marker.getLngLat();
		const newCoordinate = { lat: selected.lat, lon: selected.lng };
		const me = markers.find(x => x.marker === marker);
		if (me) {
			me.state = {
				...me.state,
				coordinate: newCoordinate,
			};
		}

		rerender();
	});

	const row = document.createElement("div");
	row.style.display = "flex";

	const titleInput = document.createElement("input");
	titleInput.classList.add("blending", "padded", "dotted");
	titleInput.value = state.title;
	titleInput.style.fontWeight = "bold";
	titleInput.style.flex = "1 1 0";
	titleInput.addEventListener("input", () => {
		const me = markers.find(x => x.marker === marker);
		if (me) {
			me.state = {
				...me.state,
				title: titleInput.value.trim(),
			};
			rerender("cheap");
		}
	});
	row.appendChild(titleInput);

	const trashButton = document.createElement("button");
	trashButton.classList.add("blending");
	trashButton.style.fontSize = "1.5em";
	trashButton.style.lineHeight = "1em";
	trashButton.textContent = "🗑️";
	trashButton.onclick = () => {
		markers.splice(0, markers.length, ...markers.filter(m => m.marker !== marker));
		row.parentElement?.removeChild(row);
		marker.remove();
		rerender();
	};
	row.appendChild(trashButton);

	placeListDiv.appendChild(row);

	markers.push({
		state: state,
		marker,
		row,
	});

	rerender();
}

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

	const shadelayers = new class Foo extends GeojsonSourcesManager<{ origins: PlaceState[], options: { maxWalkMinutes: number, maxJourneyMinutes: number[] } }> {
		constructor() {
			super(map, async (req: { origins: PlaceState[], options: { maxWalkMinutes: number, maxJourneyMinutes: number[] } }) => {
				const origins = new Map();
				for (const place of req.origins) {
					origins.set(place, place.weight);
				}
				return await generateInvertedIsolines(transitData, origins, req.options);
			});
		}
	};

	const isoSourceIDBasic = shadelayers.createSource("basic");
	const isoSourceInner = shadelayers.createSource("inner");

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

	map.addLayer({
		id: "inner-line",
		type: "line",
		source: isoSourceInner,
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
		id: "inner-inset-blur",
		type: "line",
		source: isoSourceInner,
		paint: {
			"line-color": "black",
			"line-width": 8,
			"line-blur": 8,
			"line-offset": -2,
			"line-opacity": 0.25,
		},
	});

	function rerenderIsolines(mode?: "cheap") {
		const origins = markers.map(x => x.state);
		const encodedStates = origins.map(encodePlaceState);

		const placeParams = encodedStates.length === 1
			? { p: encodedStates[0] }
			: Object.fromEntries(encodedStates.map((value, i) => [`p${i + 1}`, value]));
		const settingsParams = {
			max: settingsMaxCommuteInput.value,
			walk: settingsWalkInput.value,
		};

		const searchParams = new URLSearchParams({ ...placeParams, ...settingsParams }).toString();

		window.history.pushState({}, "", new URL("?" + searchParams, window.location.href));

		if (mode === "cheap") {
			return;
		}

		const maxJourneyMinutes = parseFloat(settingsMaxCommuteInput.value);
		const maxWalkMinutes = parseFloat(settingsWalkInput.value);

		shadelayers.recalculateSourceGeometry("basic", {
			origins,
			options: {
				maxJourneyMinutes: [maxJourneyMinutes],
				maxWalkMinutes: maxWalkMinutes,
			},
		});

		const values = [];
		for (let minute = 15; minute + 3.51 < maxJourneyMinutes; minute += 15) {
			values.push(minute);
		}

		shadelayers.recalculateSourceGeometry("inner", {
			origins,
			options: {
				maxJourneyMinutes: values,
				maxWalkMinutes: maxWalkMinutes,
			},
		});
	}

	const queryParameters = new URL(window.location.href).searchParams;

	settingsMaxCommuteInput.value = (parseFloat(queryParameters.get("max")!) || 50).toFixed(0);
	settingsMaxCommuteInput.addEventListener("change", () => rerenderIsolines());
	settingsMaxCommuteInput.disabled = false;

	settingsWalkInput.value = (parseFloat(queryParameters.get("walk")!) || 15).toFixed(0);
	settingsWalkInput.addEventListener("change", () => rerenderIsolines());
	settingsWalkInput.disabled = false;

	const placeParameters = [...queryParameters]
		.filter(([key]) => /^p[0-9]*/.test(key))
		.map(([_, value]) => value);
	const urlPlaceStates = placeParameters
		.map(decodePlaceState)
		.flatMap(x => x ? [x] : []);

	for (const urlPlaceState of urlPlaceStates) {
		addPlaceToState(urlPlaceState, rerenderIsolines);
	}

	if (urlPlaceStates.length === 0) {
		addPlaceToState({
			title: "Hachiko",
			coordinate: HACHIKO_COORDINATES,
			weight: 1,
		}, rerenderIsolines);
	}

	const addDestinationButton = document.getElementById("add-destination-button") as HTMLButtonElement;
	const addDestinationHereSpan = document.getElementById("add-destination-here-span")!;

	function nearestStation(query: Coordinate): MatrixStation {
		let nearest = transitData.stations[0];
		for (const station of transitData.stations) {
			const nearestDistance = earthGreatCircleDistanceKm(nearest.coordinate, query);
			const distance = earthGreatCircleDistanceKm(station.coordinate, query);
			if (distance < nearestDistance) {
				nearest = station;
			}
		}
		return nearest;
	}

	addDestinationButton.addEventListener("click", () => {
		const rawCenter = map.getCenter();
		const offsetCenter: Coordinate = {
			lon: rawCenter.lng,
			lat: rawCenter.lat,
		};

		const nearest = nearestStation(offsetCenter);
		addPlaceToState({
			title: "Near " + nearest.name,
			coordinate: offsetCenter,
			weight: 1,
		}, rerenderIsolines);
	});
	addDestinationButton.disabled = false;

	rerenderIsolines();
	console.log(loadTimeline.entries());
}

main();

const searchPanelResults = document.getElementById("search-panel-results") as HTMLElement;

const nominateQueryResults = new Refreshing(
	(searchString: string) => searchForPlace(searchString),
	(placeList, searchString) => {
		searchPanelResults.innerHTML = "";

		if (searchString.trim() === "") {
			searchPanelResults.classList.remove("has-results");
			return;
		}
		searchPanelResults.classList.add("has-results");

		if (placeList.length === 0) {
			const li = document.createElement("div");
			const i = document.createElement("i");
			i.textContent = "No results for ";
			const kbd = document.createElement("kbd");
			kbd.textContent = searchString;
			li.appendChild(i);
			li.appendChild(kbd);
			searchPanelResults.appendChild(li);
		} else {
			for (const place of placeList.slice(0, 5)) {
				const a = document.createElement("a");
				a.classList.add("blending", "search-result", "padded");
				a.href = "#";
				a.onclick = e => { e.preventDefault(); return false; };

				const b = document.createElement("b");
				const br = document.createElement("br");
				const d = document.createElement("small");
				b.textContent = place.shortName;
				d.textContent = place.fullName.trim().replace(/(?:, \d+-\d+)?, Japan$/g, "");
				a.appendChild(b);
				a.appendChild(br);
				a.appendChild(d);
				searchPanelResults.appendChild(a);

				a.onclick = () => {
					// Focus the map on the place.
					map.flyTo({
						// TODO: When the details panel is on the right side,
						// we should offset the center towards the right.
						center: [place.coordinate.lon + 0.003, place.coordinate.lat],
						zoom: 14.5,
						duration: 200,
						essential: true,
					});
				};
			}
		}
	},
);

const nominateQuery = new Stabilizing<string>(500, searchString => {
	nominateQueryResults.update(searchString);
});

const nominateInput = document.getElementById("search-input") as HTMLInputElement;
nominateInput.disabled = false;
nominateInput.oninput = () => {
	nominateQuery.update(nominateInput.value);
};

const searchPanel = document.getElementById("over-search-container") as HTMLElement;
const searchPanelFocused = new Stabilizing<boolean>(400, isSearchPanelFocused => {
	searchPanel.classList.toggle("search-panel-focused", isSearchPanelFocused);
});

function focusOnSearchResults() {
	searchPanelFocused.update(true, 10);
}

searchPanel.addEventListener("focusin", focusOnSearchResults);
searchPanel.addEventListener("pointerdown", focusOnSearchResults);
searchPanel.addEventListener("click", focusOnSearchResults);

function detectBlurOfSearchResults(e: Event) {
	if (!e.target || (e.target instanceof Node && !searchPanel.contains(e.target))) {
		searchPanelFocused.update(false);
		if (nominateInput.value.trim() === "") {
			nominateInput.value = "";
		}
	}
}
document.body.addEventListener("focusin", detectBlurOfSearchResults);
document.body.addEventListener("pointerdown", detectBlurOfSearchResults);
document.body.addEventListener("click", detectBlurOfSearchResults);
