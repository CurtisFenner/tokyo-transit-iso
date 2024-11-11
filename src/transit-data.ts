import { earthGreatCircleDistanceKm, STANDARD_WALKING_SPEED_KPH } from "./geometry";
import { loadLineLogos } from "./images";
import { loadWikidata, Wikidata } from "./matchstations";
import * as spatial from "./data/spatial";

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

function walkingMatrix(
	matrices: Matrices,
	options: {
		maxWalkMinutes: number,
	},
): { to: StationOffset, minutes: number }[][] {
	const maxWalkKm = STANDARD_WALKING_SPEED_KPH * options.maxWalkMinutes;
	let count = 0;

	const walkingTransfers: { to: StationOffset, minutes: number }[][] = [];
	for (let i = 0; i < matrices.stations.length; i++) {
		walkingTransfers[i] = [];
	}

	const grid = new spatial.Spatial<MatrixStation>(12);
	const indices = new Map<MatrixStation, StationOffset>();
	for (let i = 0; i < matrices.stations.length; i++) {
		indices.set(matrices.stations[i], i as StationOffset);
		grid.add(matrices.stations[i]);
	}

	for (let from = 0; from < matrices.stations.length; from++) {
		const fromStation = matrices.stations[from];

		for (const toStation of grid.nearby(fromStation.coordinate, maxWalkKm)) {
			const to = indices.get(toStation)!;
			const distanceKm = earthGreatCircleDistanceKm(fromStation.coordinate, toStation.coordinate);

			const minutes = distanceKm / STANDARD_WALKING_SPEED_KPH * 60;
			if (minutes < options.maxWalkMinutes) {
				walkingTransfers[from].push({ to, minutes });
				walkingTransfers[to].push({ to: from as StationOffset, minutes });
				count += 1;
			}
		}
	}

	return walkingTransfers;
}

async function loadMatrices(): Promise<Matrices> {
	const fet = fetch("generated/morning-matrix.json.gze");
	const f = await fet;
	const gzipBlob = await f.blob();
	const decompressedStream = gzipBlob.stream().pipeThrough(new DecompressionStream("gzip"));
	const decompressedBlob = await new Response(decompressedStream).json();
	return decompressedBlob as Matrices;
}

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
			new Map(matrices.stations.map((x, i) => [i as StationOffset, x])),
		),
		wikidata,
		stations: matrices.stations,
		lines: matrices.lines,
	};
}
