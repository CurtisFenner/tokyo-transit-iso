type StationOffset = number & { __brand: "StationOffset" };

type Coordinate = { readonly lat: number, readonly lon: number };

type TrainLabel = {
	departing: number,
	service: string | null,
	destination: string | null,
	line: number | null,
};

type Stats = {
	avg: number,
};

type MatrixDistance = {
	to: StationOffset,
	/**
	 * Includes wait, but no transfer penalty.
	 */
	minutes: Stats,
	route: TrainLabel[],
};

type Matrix = {
	embarkMinutes: [number, number],
	distances: MatrixDistance[][],
};

type MatrixStation = {
	name: string,
	kana: string,
	coordinate: Coordinate,
};

type MatrixLine = {
	name: string,
	stops: number[],
};

type Matrices = {
	stations: MatrixStation[],
	lines: MatrixLine[],
	matrices: Matrix[],
};
