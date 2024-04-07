import * as spatial from "./spatial";

type WikidataRow = {
	line: string,
	line_en?: string,
	lineLogo?: string,
	lineLabel: string,
	lineOperator?: string,
	station: string,
	station_en?: string,
	stationLabel: string,
	stationCode?: string,
	stationCoordinate?: string,
};

type WikidataLine = {
	line: string,
	line_en?: string,
	lineLogo?: string,
	lineLabel: string,
	lineOperator?: string,

	stations: Set<string>,
	qID: string,
};

type WikidataStation = {
	station: string,
	station_en?: string,
	stationLabel: string,
	stationCode?: string,
	stationCoordinate?: string,
	coordinate: Coordinate,

	lines: Set<string>,
};

function cleanStationName(name: string): string {
	return name.replace(/\s+/g, "").replace(/[(〔][^()]+[\)〕]/g, "").replace(/駅$/g, "").normalize("NFKD");
}

function cleanLineName(name: string): string {
	return name.replace(/\s+/g, "").replace(/[(〔][^()]+[\)〕]/g, "").replace(/(線|ライン)$/g, "").normalize("NFKD");
}


const hachiko = { lon: 139.7006793, lat: 35.6590699 };

export class Wikidata {
	private lines = new Map<string, WikidataLine>();
	private stations = new Map<string, WikidataStation>();

	private stationGrid = new spatial.Spatial<WikidataStation>(12);

	constructor(public readonly rows: WikidataRow[]) {
		for (const row of rows) {
			if (!this.lines.has(row.line)) {
				this.lines.set(row.line, {
					line: row.line,
					line_en: row.line_en,
					lineLogo: row.lineLogo,
					lineLabel: row.lineLabel,
					lineOperator: row.lineOperator,
					stations: new Set(),
					qID: row.line.match(/Q[0-9]+/)![0],
				});
			}
			this.lines.get(row.line)!.stations.add(row.station);
		}

		for (const row of rows) {
			if (!row.stationCoordinate) {
				continue;
			}
			const match = row.stationCoordinate.match(/Point\(\s*([0-9.-]+)\s+([0-9.-]+)\s*\)/);
			if (!match) {
				continue;
			}

			const coordinate: Coordinate = {
				lon: parseFloat(match[1]),
				lat: parseFloat(match[2]),
			};

			if (!this.stations.has(row.station)) {
				this.stations.set(row.station, {
					station: row.station,
					station_en: row.station_en,
					stationLabel: row.stationLabel,
					stationCode: row.stationCode,
					stationCoordinate: row.stationCoordinate,
					coordinate,

					lines: new Set(),
				});
			}
			this.stations.get(row.station)!.lines.add(row.line);
		}

		for (const station of this.stations.values()) {
			if (!station.coordinate) {
				console.error("new Wikidata:", station, "is missing coordinates");
				continue;
			}
			this.stationGrid.add(station);
		}
	}

	matchedStations = new Map<MatrixStation, WikidataStation>();
	matchStations(stations: MatrixStation[]): void {
		for (const station of stations) {
			const nearby = this.nearbyStations(station, { radiusKm: 2 });
			const namesMatch = nearby.filter(x => cleanStationName(x.stationLabel) === cleanStationName(station.name));

			if (namesMatch.length === 1) {
				this.matchedStations.set(station, namesMatch[0]);
			}
		}
	}

	matchedLines = new Map<MatrixLine, WikidataLine>();
	matchLines(matrices: Matrices) {
		for (const line of matrices.lines) {
			const wikiStations: WikidataStation[] = [];
			for (const stationID of new Set(line.stops)) {
				const station = matrices.stations[stationID];
				const wikiStation = this.matchedStations.get(station);
				if (wikiStation !== undefined) {
					wikiStations.push(wikiStation);
				}
			}
			const candidateLineIDs = new Set(wikiStations.flatMap(w => [...w.lines]));
			const candidateLines = [...candidateLineIDs].map(x => this.lines.get(x)!);
			const choices = candidateLines.map(candidateLine => {
				const candidateStations = [...candidateLine.stations].map(stationKey => this.stations.get(stationKey)!);
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
				&& choices[0].score >= 0.085
				&& (choices.length < 2 || choices[1].score < choices[0].score / 2)
			) {
				this.matchedLines.set(line, choices[0].candidateLine);
			} else {
				// console.log("\t", matrixStops);
				// console.log("candidate lines:");
				// for (const c of choices) {
				// 	console.log("\t" + c.candidateLine.lineLabel, c.candidateCovered.length + "/" + c.candidateLine.stations.size, "v", c.lineCovered.length + "/" + new Set(line.stops).size);
				// 	console.log("\t\tmissing ", [...c.candidateLine.stations].map(stationKey => this.stations.get(stationKey)).filter(x => x && !wikiStations.includes(x)).map(x => x?.stationLabel));
				// }
				// console.log("");
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
	const f = await fetch("wikidata/line-stations.json");
	return new Wikidata(await f.json());
}
