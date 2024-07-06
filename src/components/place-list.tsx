import { ReactNode, useEffect, useState } from "react";
import { TransitData } from "../transit-data";
import * as maplibregl from "maplibre-gl";
import { HACHIKO_COORDINATES } from "../matchstations";
import { IsoShadeLayer } from "./isoshadelayer";

export type PlaceEntry = {
	name: string,
	address?: string,
	coordinate: Coordinate,
	maxMinutes: number,
};

export function Waiting<T>(props: {
	children: (t: T) => ReactNode,
	promise: Promise<T>,
	waiting: ReactNode,
	failed: (error: unknown) => ReactNode,
}) {
	const [now, setState] = useState<
		{ state: "waiting" } | { state: "success", success: T } | { state: "error", error: unknown }
	>({ state: "waiting" });
	useEffect(() => {
		setState({ state: "waiting" });
		props.promise.then(success => {
			setState({ state: "success", success });
		});
		props.promise.catch(error => {
			setState({ state: "error", error });
		});
	}, [props.promise]);

	if (now.state === "success") {
		return props.children(now.success);
	} else if (now.state === "waiting") {
		return props.waiting;
	} else {
		return props.failed(now.error);
	}
}

export type PlaceListProps = {
	initial: PlaceEntry[],
	transitData: TransitData,
	onChange?: (entries: PlaceEntry) => void,
	isoshade: IsoShadeLayer<{
		coordinate: Coordinate,
		options: { maxWalkMinutes: number, maxJourneyMinutes: number },
	}>,
};

export function PlaceList(props: PlaceListProps) {
	const [entries, changeEntries] = useState(props.initial.map(x => {
		return { ...x, id: Math.random().toFixed(12).substring(2) };
	}));

	const updateEntry = (id: string, modifier: (old: PlaceEntry) => PlaceEntry) => {
		changeEntries(old => {
			return old.map(e => {
				if (e.id === id) {
					return { ...modifier(e), id };
				}
				return e;
			});
		});
	};

	const dropEntry = (id: string) => {
		changeEntries(old => {
			props.isoshade.deleteShadeLayer(id);
			return old.filter(x => x.id !== id);
		});
	};

	return <ul>
		{entries.map((entry, i) => {
			return <PlaceEntryLine
				key={entry.id}
				initialMaxMinutes={entry.maxMinutes}
				initialName={entry.name}
				initialCoordinate={HACHIKO_COORDINATES}
				onChange={async e => {
					props.isoshade.updateShadeSource(entry.id, {
						coordinate: e.coordinate,
						options: {
							maxJourneyMinutes: e.maxMinutes,
							maxWalkMinutes: 30,
						},
					});
				}}
				map={props.isoshade.map}
				onTrash={() => {
					dropEntry(entry.id);
				}} >
				{state =>
					<NearbyStationsList transitData={props.transitData} center={state.coordinate} max={5} />
				}
			</PlaceEntryLine>;
		})}
	</ul>;
}

export type NearbyStationsListProps = {
	transitData: TransitData,
	center: Coordinate,
	max: number,
};
export function NearbyStationsList(props: NearbyStationsListProps) {
	const nearest = props.transitData.walkingData.nearby(props.center)
		.filter((v, _, arr) => v.timeMinutes < 35 || v.timeMinutes < arr[0].timeMinutes + 5)
		.slice(0, props.max);
	return <ul>
		{nearest.map((nearby, t) => {
			const stationEn = props.transitData.wikidata.matchedStations.get(nearby.station)?.station_en;
			return <li key={nearby.stationID}>
				<b>
					<ruby>{nearby.station.name.replace(/\(.*\)/g, "")}<rt>{nearby.station.kana}</rt></ruby> {stationEn && "(" + stationEn + ")"}
				</b>
				: {nearby.timeMinutes.toFixed(0)} minute walk away
			</li>;
		})}
	</ul>;
}

export type PlaceEntryLineProps = {
	initialName: string,
	initialCoordinate: Coordinate,
	initialAddress?: string,
	initialMaxMinutes: number,
	onTrash: () => void,
	onChange: (p: {
		name: string,
		address?: string,
		maxMinutes: number,
		coordinate: Coordinate,
	}) => void,
	children?: (state: {
		name: string,
		address?: string,
		maxMinutes: number,
		coordinate: Coordinate,
	}) => ReactNode,
	map: maplibregl.Map,
};

export function PlaceEntryLine(props: PlaceEntryLineProps) {
	const [name, setName] = useState(props.initialName);
	const [address, setAddress] = useState(props.initialAddress);
	const [maxMinutes, setMaxMinutes] = useState(props.initialMaxMinutes);
	const [coordinate, setCoordinate] = useState(props.initialCoordinate);

	const notify = () => {
		props.onChange({
			name,
			address,
			maxMinutes,
			coordinate,
		});
	};
	notify();

	useEffect(() => {
		const marker = new maplibregl.Marker({ draggable: true })
			.setLngLat(coordinate)
			.addTo(props.map);

		marker.on("dragend", async () => {
			const selected = marker.getLngLat();
			const newCoordinate = { lat: selected.lat, lon: selected.lng };
			setCoordinate(newCoordinate);
			setAddress(undefined);
		});

		return () => { marker.remove() };
	}, []);

	return <li>
		<div style={{
			display: "flex",
		}}>
			<input className="blend-in"
				value={name}
				onInput={e => { setName(e.currentTarget.value); }}
				style={{
					flexGrow: 1,
				}}
			/>
			<button onClick={() => props.onTrash()}>Remove</button>
		</div>
		{address && <div className="dim">{address}</div>}
		<div>
			Travel up to <select
				value={maxMinutes}
				onInput={e => { setMaxMinutes(parseFloat(e.currentTarget.value)); }}>
				<option value={15}>15 minutes</option>
				<option value={30}>30 minutes</option>
				<option value={45}>45 minutes</option>
				<option value={60}>60 minutes</option>
				<option value={75}>75 minutes</option>
				<option value={90}>90 minutes</option>
				<option value={120}>120 minutes</option>
			</select> from here.<br />
			{props.children && props.children({
				name,
				address,
				maxMinutes,
				coordinate,
			})}
		</div>
	</li>;
}
