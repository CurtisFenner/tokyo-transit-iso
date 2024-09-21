import { ReactNode, useEffect, useRef, useState } from "react";
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

function rerenderEntry(
	isoshade: IsoShadeLayer<{
		coordinate: Coordinate,
		options: { maxWalkMinutes: number, maxJourneyMinutes: number },
	}>,
	entry: {
		id: string,
		coordinate: Coordinate,
		maxMinutes: number,
	},
	options: { maxWalkMinutes: number },
) {
	isoshade.updateShadeSource(entry.id, {
		coordinate: entry.coordinate,
		options: {
			maxJourneyMinutes: entry.maxMinutes,
			maxWalkMinutes: options.maxWalkMinutes,
		},
	});
}

function useMapEffect<K, V>(map: Map<K, V>, refresh: (k: K, v: V) => void, additional: unknown[]): void {
	const old = useRef(map);
	for (const [k, v] of map) {
		if (old.current.get(k) !== v) {
			old.current.set(k, v);
			console.log("rerendering", k, "with", v);
			refresh(k, v);
		}
	}

	useEffect(() => {
		for (const [k, v] of old.current) {
			refresh(k, v);
		}
	}, additional);
}

export function PlaceList(props: PlaceListProps) {
	const [entries, updateEntries] = useState(props.initial.map(x => {
		return { ...x, id: Math.random().toFixed(12).substring(2) };
	}));

	const [maxWalkMinutes, setMaxWalkMinutes] = useState(30);

	const dropEntry = (id: string) => {
		updateEntries(old => {
			props.isoshade.deleteShadeLayer(id);
			return old.filter(x => x.id !== id);
		});
	};

	useMapEffect(new Map(entries.map(e => [e.id, e])), (_, entry) => {
		props.isoshade.updateShadeSource(entry.id, {
			coordinate: entry.coordinate,
			options: {
				maxJourneyMinutes: entry.maxMinutes,
				maxWalkMinutes: maxWalkMinutes,
			},
		});
	}, [maxWalkMinutes]);

	return <>
		<ul>
			{entries.map((entry, i) => {
				return <PlaceEntryLine
					key={entry.id}
					initialMaxMinutes={entry.maxMinutes}
					initialName={entry.name}
					initialCoordinate={HACHIKO_COORDINATES}
					onChange={async e => {
						console.log("PlaceEntryLine gave us an update!", e);
						updateEntries(old => {
							return old.map(x => {
								const y: (PlaceEntry & { id: string }) = x.id === entry.id ? { ...e, id: x.id } : x;
								return y;
							});
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
		</ul>
		<div>
			I am willing to walk up to <select
				value={maxWalkMinutes}
				onInput={e => { setMaxWalkMinutes(parseFloat(e.currentTarget.value)); }}>
				<option value={1}>1 minute</option>
				<option value={5}>5 minutes</option>
				<option value={10}>10 minutes</option>
				<option value={15}>15 minutes</option>
				<option value={20}>20 minutes</option>
				<option value={25}>25 minutes</option>
				<option value={30}>30 minutes</option>
				<option value={45}>45 minutes</option>
			</select> to and from the station.
		</div>
	</>;
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
	const [data, setDataDirect] = useState({
		name: props.initialName,
		address: props.initialAddress,
		maxMinutes: props.initialMaxMinutes,
		coordinate: props.initialCoordinate,
	});

	const updateData = function <R extends Partial<typeof data>>(r: R): void {
		setDataDirect(oldData => {
			const withUpdate = { ...oldData, ...r };
			props.onChange(withUpdate);
			return withUpdate;
		});
	};

	useEffect(() => {
		const marker = new maplibregl.Marker({ draggable: true })
			.setLngLat(data.coordinate)
			.addTo(props.map);

		marker.on("dragend", async () => {
			const selected = marker.getLngLat();
			const newCoordinate = { lat: selected.lat, lon: selected.lng };

			updateData({ coordinate: newCoordinate, address: undefined });
		});

		return () => { marker.remove() };
	}, []);

	return <li>
		<div style={{
			display: "flex",
		}}>
			<input className="blend-in"
				value={data.name}
				onInput={e => { updateData({ name: e.currentTarget.value }); }}
				style={{
					flexGrow: 1,
				}}
			/>
			<button onClick={() => props.onTrash()}>Remove</button>
		</div>
		{data.address && <div className="dim">{data.address}</div>}
		<div>
			Travel up to <select
				value={data.maxMinutes}
				onInput={e => { updateData({ maxMinutes: parseFloat(e.currentTarget.value) }); }}>
				<option value={15}>15 minutes</option>
				<option value={20}>20 minutes</option>
				<option value={25}>25 minutes</option>
				<option value={30}>30 minutes</option>
				<option value={35}>35 minutes</option>
				<option value={40}>40 minutes</option>
				<option value={45}>45 minutes</option>
				<option value={50}>50 minutes</option>
				<option value={55}>55 minutes</option>
				<option value={60}>60 minutes</option>
				<option value={65}>65 minutes</option>
				<option value={70}>70 minutes</option>
				<option value={75}>75 minutes</option>
				<option value={80}>80 minutes</option>
				<option value={90}>90 minutes</option>
				<option value={120}>2 hours</option>
				<option value={180}>3 hours</option>
				<option value={240}>4 hours</option>
			</select> from here.<br />
			{props.children && props.children(data)}
		</div>
	</li>;
}
