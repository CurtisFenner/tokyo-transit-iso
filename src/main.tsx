import * as maplibregl from "maplibre-gl";
import { ClusteredLabels } from "./components/ClusteredLabels";
import { GeojsonSourcesManager } from "./components/GeojsonSourcesManager";
import { zipKeyedMapsTotal } from "./data/data";
import { geoJSONFromRingForest, groupContainedRings } from "./data/spatial";
import * as timer from "./data/timer";
import { cleanStationName, HACHIKO_COORDINATES } from "./matchstations";
import { blendArrivals, Pathfinder } from "./pathfinding";
import { ArrivalTime, isolines } from "./search";
import { loadTransitData, TransitData } from "./transit-data";

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
	origins: Origin[],
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
	const pathfinder = new Pathfinder<Origin>(transitData, new Map(origins.map(o => [o, o.coordinate])), {
		...options,
		trainTransferPenaltyMinutes: 3,
		transferWalkingPenaltyMinutes: 3,
	});

	const reachableFromOrigin = new Map<Origin, Map<unknown, ArrivalTime>>();
	for (const origin of origins) {
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
				[...reached].map(([origin, arrival]) => [arrival, 1])
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

	const shadelayers = new class Foo extends GeojsonSourcesManager<{ coordinate: Coordinate, options: { maxWalkMinutes: number, maxJourneyMinutes: number } }> {
		constructor() {
			super(map, async (req: { coordinate: Coordinate, options: { maxWalkMinutes: number, maxJourneyMinutes: number } }) => {
				return await generateInvertedIsoline(transitData, [req], req.options,);
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

	function rerenderIsolines(coordinate: Coordinate) {
		shadelayers.recalculateSourceGeometry("basic", {
			coordinate,
			options: {
				maxJourneyMinutes: 60,
				maxWalkMinutes: 25,
			},
		});
		for (const [k, v] of isolines) {
			shadelayers.recalculateSourceGeometry(v.key, {
				coordinate,
				options: {
					maxJourneyMinutes: k,
					maxWalkMinutes: 25,
				},
			});
		}
	}

	const marker = new maplibregl.Marker({ draggable: true })
		.setLngLat(HACHIKO_COORDINATES)
		.addTo(map);

	marker.on("dragend", async () => {
		const selected = marker.getLngLat();
		const newCoordinate = { lat: selected.lat, lon: selected.lng };

		rerenderIsolines(newCoordinate);
		console.log("Current zoom:", map.getZoom());
	});
	rerenderIsolines(HACHIKO_COORDINATES);

	console.log(loadTimeline.entries());
}

main();
