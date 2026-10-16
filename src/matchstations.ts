import * as spatial from "./data/spatial";

/** From `condensed-stations.json` */
type WikidataLine = {
	id: string,
	en?: string,
	ja?: string,
	color?: string,
	logo?: string,
	code?: string,
	stations?: string[],
};

/** From `condensed-stations.json` */
type WikidataStation = {
	id: string,
	en?: string,
	ja?: string,
	coordinate: Coordinate,
	codes?: string[],
	lines: string[],
};

type WikidataCondensed = {
	lines: Record<string, WikidataLine>,
	stations: Record<string, WikidataStation>,
};

export function cleanStationName(name: string): string {
	return name.replace(/\s+/g, "")
		.replace(/[(〔][^()]+[\)〕]/g, "")
		.replace(/駅$/g, "")
		.normalize("NFKD");
}

export const HACHIKO_COORDINATES = { lon: 139.7006793, lat: 35.6590699 };

export class Wikidata {
	private lines = new Map<string, WikidataLine>();
	private stations = new Map<string, WikidataStation>();

	private stationGrid = new spatial.Spatial<WikidataStation>(12);

	constructor(public readonly data: WikidataCondensed) {
		for (const [lineID, line] of Object.entries(data.lines)) {
			this.lines.set(lineID, line);
		}
		for (const [stationID, station] of Object.entries(data.stations)) {
			if (!station.coordinate) {
				continue;
			}
			this.stations.set(stationID, station);
			this.stationGrid.add(station);
		}
	}

	matchedStations = new Map<MatrixStation, WikidataStation>();
	matchStations(stations: MatrixStation[]): void {
		for (const station of stations) {
			const nearby = this.nearbyStations(station, { radiusKm: 2 });
			const namesMatch = nearby.filter(x => !!x.ja && cleanStationName(x.ja) === cleanStationName(station.name));

			if (namesMatch.length === 1) {
				this.matchedStations.set(station, namesMatch[0]);
			}
		}
	}

	matchedLines = new Map<MatrixLine, WikidataLine>();
	matchLines(matrices: Matrices) {
		for (const line of matrices.lines) {
			const wikiStations: WikidataStation[] = [];
			const stopsWithoutWiki = [];
			for (const stationID of new Set(line.stops)) {
				const station = matrices.stations[stationID];
				const wikiStation = this.matchedStations.get(station);
				if (wikiStation !== undefined) {
					wikiStations.push(wikiStation);
				} else {
					stopsWithoutWiki.push(station);
				}
			}
			const candidateLineIDs = new Set(wikiStations.flatMap(w => [...w.lines]));
			const candidateLines = [...candidateLineIDs].map(x => this.lines.get(x)!)
				.filter(x => x);
			const choices = candidateLines.map(candidateLine => {
				const candidateStations = [...(candidateLine.stations || [])]
					.map(stationKey => this.stations.get(stationKey)!);
				const candidateCovered = candidateStations.filter(x => wikiStations.includes(x));
				const lineCovered = wikiStations.filter(x => candidateStations.includes(x))
				return {
					candidateLine,
					candidateCovered,
					lineCovered,
					score: (candidateCovered.length / line.stops.length) * (lineCovered.length / line.stops.length),
				};
			}).sort((a, b) => b.score - a.score);

			if (
				choices.length >= 1
				&& choices[0].score >= 0.04
				&& (choices.length < 2 || choices[1].score < choices[0].score / 2)
			) {
				this.matchedLines.set(line, choices[0].candidateLine);
			} else {
				console.log("matching", line.name, "failed...");
				console.log("wikiStations:", wikiStations);
				console.log("stopsWithoutWiki:", stopsWithoutWiki);
				console.log("candidateLines:", candidateLines);
				console.log("ranked choices:", choices);
			}
		}
	}

	nearbyStations(query: MatrixStation, p: { radiusKm: number }): WikidataStation[] {
		if (!query.coordinate) {
			return [];
		}

		return this.stationGrid.nearby(query.coordinate, p.radiusKm);
	}
}

export async function loadWikidata(): Promise<Wikidata> {
	const f = await fetch("wikidata/condensed-stations.json");
	return new Wikidata(await f.json());
}
