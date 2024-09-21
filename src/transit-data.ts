import { earthGreatCircleDistanceKm, STANDARD_WALKING_SPEED_KPH } from "./geometry";
import { loadLineLogos } from "./images";
import { loadWikidata, Wikidata } from "./matchstations";
import { loadMatrices, StationOffset, walkingMatrix } from "./search";

class WalkingData {
	constructor(
		public readonly matrix: { to: StationOffset, minutes: number }[][],
		public readonly stationCoordinates: Map<StationOffset, MatrixStation>,
	) { }

	nearby(point: Coordinate): {
		stationID: StationOffset,
		station: MatrixStation,
		distanceKm: number,
		timeMinutes: number,
	}[] {
		const out = [];
		for (const [stationID, station] of this.stationCoordinates) {
			const distanceKm = earthGreatCircleDistanceKm(point, station.coordinate);
			const walkingHours = distanceKm / STANDARD_WALKING_SPEED_KPH;
			const walkingMinutes = walkingHours * 60;
			out.push({
				stationID,
				station,
				distanceKm,
				timeMinutes: walkingMinutes,
			});
		}
		return out.sort((a, b) => a.distanceKm - b.distanceKm);
	}
}

export type TransitData = {
	trainOutEdges: MatrixDistance[][],
	walkingData: WalkingData,
	wikidata: Wikidata,
	stations: MatrixStation[],
	lines: MatrixLine[],
};

export async function loadTransitData(
	options: { maxWalkMinutes: number },
): Promise<TransitData> {
	const matrices = await loadMatrices();
	const wikidata = await loadWikidata();
	wikidata.matchStations(matrices.stations);
	wikidata.matchLines(matrices);

	const wikiLineLogos = await loadLineLogos();
	const matrixLineLogos = [];
	for (const line of matrices.lines) {
		const matched = wikidata.matchedLines.get(line);
		if (!matched) {
			matrixLineLogos.push(undefined);
			continue;
		}
		matrixLineLogos.push(wikiLineLogos.rectangles[matched.qID]);
	}

	return {
		trainOutEdges: matrices.matrices[0].distances,
		walkingData: new WalkingData(
			walkingMatrix(matrices, options),
			new Map(matrices.stations.map((x, i) => [i, x])),
		),
		wikidata,
		stations: matrices.stations,
		lines: matrices.lines,
	};
}
