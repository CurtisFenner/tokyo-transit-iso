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
	coordinate?: Coordinate,

	lines: Set<string>,
};

function cleanStationName(name: string): string {
	return name.replace(/\s+/g, "").replace(/\([^()]+\)/g, "").replace(/駅$/g, "");
}

function cleanLineName(name: string): string {
	return name.replace(/\s+/g, "").replace(/\([^()]+\)/g, "").replace(/(線|ライン)$/g, "");
}

class Wikidata {
	private lines = new Map<string, WikidataLine>();
	private stations = new Map<string, WikidataStation>();
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
				lat: parseFloat(match[2]),
				lon: parseFloat(match[1]),
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
	}

	matchLine(query: MatrixLine, incident: WikidataStation[]): WikidataLine | null {
		const matches = [...this.lines.values()].filter(x => cleanLineName(x.lineLabel) === cleanLineName(query.name));
		if (matches.length === 1) {
			return matches[0];
		}

		// Are there 3 stations in incident that are unique to one line?
		const lines: Record<string, number> = {};
		for (const station of incident) {
			for (const line of station.lines) {
				lines[line] = (lines[line] || 0) + 1;
			}
		}

		const hits = Object.entries(lines)
			.sort((a, b) => b[1] - a[1]);
		if (
			(hits.length === 1 && hits[0][1] >= 3)
			|| (hits.length >= 2 && hits[0][1] >= 3 && hits[1][1] < 3)
			|| (hits.length >= 2 && hits[0][1] > 3 * hits[1][1])
			|| (hits.length >= 1 && hits[0][1] === query.stops.length && (hits.length === 1 || hits[1][1] < hits[0][1]))
		) {
			return this.lines.get(hits[0][0])!;
		}

		return null;
	}

	nearbyStation(query: MatrixStation, p: { radiusKm: number }): WikidataStation | null {
		if (!query.coordinate) {
			return null;
		}

		const located = [...this.stations.values()].filter(x => x.coordinate) as (WikidataStation & { coordinate: Coordinate })[];
		const nearby = located
			.filter(x => earthGreatCircleDistanceKm(x.coordinate, query.coordinate!) < p.radiusKm)
			.filter(x => cleanStationName(x.stationLabel) === cleanStationName(query.name));

		if (nearby.length === 1) {
			return nearby[0];
		}
		return null;
	}
}

async function loadWikidata(): Promise<Wikidata> {
	const f = await fetch("wikidata/line-stations.json");
	return new Wikidata(await f.json());
}
