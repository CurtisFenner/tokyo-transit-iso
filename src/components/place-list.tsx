import { useState } from "react";

export type PlaceEntry = {
	name: string,
	address?: string,
	coordinate: Coordinate,
	maxMinutes: number,
};

export type PlaceListProps = {
	initial: PlaceEntry[],
	onChange?: (entries: PlaceEntry) => void,
};

export function PlaceList(props: PlaceListProps) {
	const [entries, changeEntries] = useState(props.initial.map(x => {
		return { ...x, id: Math.random() };
	}));

	const updateEntry = (id: number, modifier: (old: PlaceEntry) => PlaceEntry) => {
		changeEntries(old => {
			return old.map(e => {
				if (e.id === id) {
					return { ...modifier(e), id };
				}
				return e;
			});
		});
	};

	const dropEntry = (id: number) => {
		changeEntries(old => {
			return old.filter(x => x.id !== id);
		});
	};

	return <ul>
		{entries.map((entry, i) => {
			return <PlaceEntryLine
				key={i}
				maxMinutes={entry.maxMinutes}
				onMaxMinutesChange={newMaxMinutes => {
					updateEntry(entry.id, o => ({ ...o, maxMinutes: newMaxMinutes }));
				}}
				name={entry.name}
				onNameChange={newName => {
					updateEntry(entry.id, o => ({ ...o, name: newName }));
				}}
				onTrash={() => {
					dropEntry(entry.id);
				}} />;
		})}
	</ul>;
}

export type PlaceEntryLineProps = {
	name: string,
	onNameChange: (s: string) => void,
	address?: string,
	onTrash: () => void,
	maxMinutes: number,
	onMaxMinutesChange: (maxMinutes: number) => void,
};

export function PlaceEntryLine(props: PlaceEntryLineProps) {
	return <li>
		<div style={{
			display: "flex",
		}}>
			<input className="blend-in"
				value={props.name}
				onInput={e => props.onNameChange(e.currentTarget.value)}
				style={{
					flexGrow: 1,
				}}
			/>
			<button onClick={() => props.onTrash()}>Remove</button>
		</div>
		{props.address && <div className="dim">{props.address}</div>}
		<div>
			Travel up to <select
				value={props.maxMinutes}
				onInput={e => props.onMaxMinutesChange(parseFloat(e.currentTarget.value))}>
				<option value={20}>15 minutes</option>
				<option value={30}>30 minutes</option>
				<option value={45}>45 minutes</option>
				<option value={60}>60 minutes</option>
				<option value={75}>75 minutes</option>
				<option value={90}>90 minutes</option>
				<option value={120}>120 minutes</option>
			</select> from here.
		</div>
	</li >
}
