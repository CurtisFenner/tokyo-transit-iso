import * as fs from "node:fs/promises";

const stationsJson = JSON.parse(await fs.readFile("just-stations.json", "utf-8"));
const linesJson = JSON.parse(await fs.readFile("just-lines.json", "utf-8"));

/**
 * @typedef {{}} LineInfo
 * @type {Record<string, LineInfo>}
*/
const lines = {};

/**
 * @typedef {{}} StationInfo
 * @type {Record<string, StationInfo>}
 */
const stations = {};

for (const row of linesJson) {
	const lineId = row.line.match(/\/entity\/(.+)$/)[1];
	lines[lineId] = lines[lineId] || {
		id: lineId,
		en: row.line_en,
		ja: row.line_ja,
		color: row.line_color,
		logo: row.line_logo,
		code: row.line_code,
		stations: [],
	};
}

for (const row of stationsJson) {
	try {
		const stationId = row.station.match(/\entity\/(.+)$/)[1];
		if (!row.station_coordinate) {
			console.log("station", stationId, "is missing coordinate:", row);
			continue;
		}

		const coordinate = row.station_coordinate?.match(/\(([0-9.+-]+)\s+([0-9.+-]+)\)/);
		const stationLines = row.lines?.split(",")
			.filter(x => x !== "http://www.wikidata.org/.well-known/genid/fbfca98b5b43c3a7ed9b29b6502e3342")
			.map(lineUrl => lineUrl.match(/\entity\/(.+)$/)[1])
			|| [];
		if (!stationLines.length) {
			console.log("station", stationId, "is missing connecting-services");
			continue;
		}
		stations[stationId] = stations[stationId] || {
			id: stationId,
			en: row.station_en,
			ja: row.station_ja,
			coordinate: coordinate && { lon: parseFloat(coordinate[1]), lat: parseFloat(coordinate[2]) },
			codes: row.station_codes?.split(","),
			lines: stationLines,
		};

		for (const lineId of stationLines) {
			lines[lineId]?.stations.push(stationId);
		}
	} catch (err) {
		console.error("encountered error processing row:");
		console.error("\t" + JSON.stringify(row));
		throw err;
	}
}

const output = JSON.stringify(
	{
		stations,
		lines,
	},
	null,
	"\t",
);

await fs.writeFile("condensed-stations.json", output);
