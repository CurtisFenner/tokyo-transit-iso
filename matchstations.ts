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

function toTile(zoom: number, coordinate: Coordinate): {
	x: number, y: number,
	ix: number, iy: number,
} {
	const x3857 = coordinate.lon;
	const latRad = coordinate.lat * Math.PI / 180;
	const y3857 = Math.log(Math.tan(latRad) + 1 / Math.cos(latRad));
	const x = 0.5 + x3857 / 360;
	const y = 0.5 - y3857 / (2 * Math.PI);
	const n = 2 ** zoom;
	return {
		x: n * x,
		y: n * y,
		ix: Math.floor(n * x),
		iy: Math.floor(n * y),
	};
}

const hachiko = { lon: 139.7006793, lat: 35.6590699 };

class Wikidata {
	private lines = new Map<string, WikidataLine>();
	private stations = new Map<string, WikidataStation>();

	private stationsByGrid17 = new Map<string, (WikidataStation)[]>();

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
			const tileID = this.tileID17(station.coordinate);
			const gridTile = this.stationsByGrid17.get(tileID) || [];
			gridTile.push(station);
			this.stationsByGrid17.set(tileID, gridTile);
		}
	}

	tileID17(coordinate: Coordinate): string {
		const tile = toTile(17, coordinate);
		return `${tile.ix}/${tile.iy}`;
	}

	stationsInNeighborhood(query: Coordinate) {
		const [ix, iy] = this.tileID17(query).split("/");
		const out: Record<string, WikidataStation[] | undefined> = {};
		for (let u = -1; u <= 1; u++) {
			for (let v = -1; v <= 1; v++) {
				const neighbor = `${parseInt(ix) + u}/${parseInt(iy) + v}`;
				const grid = this.stationsByGrid17.get(neighbor);
				out[neighbor] = grid;
			}
		}
		return out;
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

			// console.log("match", line.name);
			// console.log("candidates:");
			// for (const c of choices) {
			// 	console.log("\t" + c.candidateLine.lineLabel, c.candidateCovered.length + "/" + c.candidateLine.stations.size, "v", c.lineCovered.length + "/" + new Set(line.stops).size);
			// 	console.log("\t\tmissing ", [...c.candidateLine.stations].map(stationKey => this.stations.get(stationKey)).filter(x => x && !wikiStations.includes(x)).map(x => x?.stationLabel));
			// }
			// console.log(choices.length, choices[0]?.score, choices[1]?.score);

			if (choices.length === 0) {
				continue;
			} else if (choices[0].score < 0.085) {
				continue;
			} else if (choices.length >= 2 && choices[1].score > choices[0].score / 2) {
				continue;
			}
			this.matchedLines.set(line, choices[0].candidateLine);
		}
	}

	nearbyStations(query: MatrixStation, p: { radiusKm: number }): WikidataStation[] {
		if (!query.coordinate) {
			return [];
		}

		return Object.entries(this.stationsInNeighborhood(query.coordinate)).map(([_, x]) => x || []).flat()
			.filter(x => earthGreatCircleDistanceKm(x.coordinate, query.coordinate!) < p.radiusKm);
	}
}

async function loadWikidata(): Promise<Wikidata> {
	const f = await fetch("wikidata/line-stations.json");
	return new Wikidata(await f.json());
}
