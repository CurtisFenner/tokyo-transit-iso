import { LocalCoordinate, LocalPlane, earthGreatCircleDistanceKm, geoMidpoint } from "./geometry";
import { SimpleGraph, components } from "./data/graph";
import { HACHIKO_COORDINATES } from "./matchstations";
import * as spatial from "./data/spatial";

export type Arrival = {
	coordinate: Coordinate,
	arrivalMinutes: number,
};

export type LocalCircle = {
	center: LocalCoordinate,
	radiusKm: number,
};

type HexTile = {
	key: string,
	gx: number,
	gy: number,
	row: number,
	column: number,
	topLeft: LocalCoordinate,
};

type HexGrid = {
	boxSize: number,
};

function toHexTile(
	point: LocalCoordinate,
	p: HexGrid,
): HexTile {
	const column = Math.floor(point.xKm / p.boxSize);
	const parity = column % 2 === 0 ? 0 : 1;
	const row = Math.floor(point.yKm / p.boxSize - parity * 0.5);

	return {
		key: row + "," + column,
		gx: column * 2,
		gy: row * 2 + parity,
		row,
		column,
		topLeft: {
			xKm: column * p.boxSize,
			yKm: (row + 0.5 * parity) * p.boxSize,
		},
	};
}

function* hexTilesInRadius(
	center: LocalCoordinate,
	radiusKm: number,
	p: HexGrid,
): Generator<HexTile, void, unknown> {
	for (let x = -radiusKm; x <= radiusKm; x += p.boxSize) {
		for (let y = -radiusKm; y <= radiusKm; y += p.boxSize) {
			if (x * x + y * y <= (radiusKm + p.boxSize) ** 2) {
				yield toHexTile({ xKm: center.xKm + x, yKm: center.yKm + y }, p);
			}
		}
	}
}

function limitedTo(x: number, { near, within }: { near: number, within: number }) {
	return Math.max(near - within, Math.min(x, near + within));
}

export async function assignTiles<TArrival extends Arrival>(
	arrivals: TArrival[],
	p: {
		boxKm: number,
		maxRadiusKm: number,
		maxMinutes: number,
		speedKmPerMin: number,
	},
): Promise<{
	corners: Map<`${number},${number}`, Coordinate>,
	cells: { tile: HexTile, corners: Coordinate[], arrival: TArrival }[],
	debugLines: Coordinate[][],
}> {
	const spatialArrivals = new spatial.Spatial<TArrival>(12);
	for (const arrival of arrivals) {
		spatialArrivals.add(arrival);
	}

	const local = LocalPlane.nearPoint(HACHIKO_COORDINATES);

	const cornerCache = new Map<string, { coordinate: Coordinate, adjusts: Coordinate[] }>();
	function cornerCoordinate(gx: number, gy: number): { coordinate: Coordinate, adjusts: Coordinate[] } {
		const key = gx + "," + gy;
		const existing = cornerCache.get(key);
		if (existing !== undefined) {
			return existing;
		}

		// Idea:
		// Use the current distances & derivatives of distances to make a local
		// approximation of where the edge would be.
		// Nudge the corner towards that.
		const c = {
			xKm: gx * p.boxKm / 2 + (0) * p.boxKm / 6,
			yKm: gy * p.boxKm / 2 + (0) * p.boxKm / 6,
		};
		const out = { coordinate: local.toGlobe(c), adjusts: [] };
		cornerCache.set(key, out);
		return cornerCoordinate(gx, gy);
	}

	const grid: HexGrid = {
		boxSize: p.boxKm,
	};
	const halfTile: LocalCoordinate = { xKm: grid.boxSize / 2, yKm: grid.boxSize / 2 };
	const tiles = new Map<string, { tile: HexTile, from: TArrival | null }>();

	const debugLines: Coordinate[][] = [];

	for (const arrival of arrivals) {
		if (arrival.arrivalMinutes > p.maxMinutes - 1) {
			continue;
		}

		let count = 0;
		let fresh = 0;
		for (const tile of hexTilesInRadius(local.toLocal(arrival.coordinate), p.maxRadiusKm, grid)) {
			count += 1;
			if (tiles.has(tile.key)) {
				continue;
			}
			fresh += 1;

			const tileCenter = local.toGlobe(local.add(tile.topLeft, halfTile));
			const nearby = spatialArrivals.nearby(tileCenter, p.maxRadiusKm).map(near => {
				const distance = earthGreatCircleDistanceKm(tileCenter, near.coordinate);
				const timeMinutes = near.arrivalMinutes + distance / p.speedKmPerMin;
				return {
					station: near,
					timeMinutes,
				};
			}).sort((a, b) => a.timeMinutes - b.timeMinutes);

			let nearest: {
				station: TArrival;
				timeMinutes: number;
			} | null = nearby[0] || null;
			if (nearest !== null) {
				let containedCorners = 0;

				for (let u = -1; u <= 1; u += 2) {
					for (let v = -1; v <= 1; v += 2) {
						const tileCorner = local.add(tile.topLeft, { xKm: (u * 0.25 + 0.5) * p.boxKm, yKm: (v * 0.25 + 0.5) * p.boxKm });
						const distance = earthGreatCircleDistanceKm(local.toGlobe(tileCorner), nearest.station.coordinate);
						const timeMinutes = nearest.station.arrivalMinutes + distance / p.speedKmPerMin;

						if (distance < p.maxRadiusKm && timeMinutes < p.maxMinutes) {
							containedCorners += 1;
						}
					}
				}
				if (containedCorners < 2) {
					nearest = null;
				}
			}

			tiles.set(tile.key, { tile, from: nearest && nearest.station });

			if (nearest !== null) {
				const stationCenters = nearby.slice(0, 3).map(near => {
					const maxRadius = Math.min(
						p.maxRadiusKm,
						(p.maxMinutes - nearest.station.arrivalMinutes) * p.speedKmPerMin,
					);
					return {
						station: near.station,
						maxRadius,
						local: local.toLocal(near.station.coordinate),
					};
				});
				for (let u = tile.gx; u <= tile.gx + 2; u += 2) {
					for (let v = tile.gy; v <= tile.gy + 2; v++) {

						const corner = cornerCoordinate(u, v);
						const cornerLocal = local.toLocal(corner.coordinate);
						const localToNearest = local.subtract(cornerLocal, stationCenters[0].local);

						const limiters = stationCenters.map(stationCenter => {
							const toCorner = local.subtract(cornerLocal, stationCenter.local);
							const distance = local.magnitude(toCorner);
							const timeMinutes = stationCenter.station.arrivalMinutes + distance / p.speedKmPerMin;
							const changeRateFromNearest = local.dot(local.unit(localToNearest), local.unit(toCorner));

							return {
								center: stationCenter.station,
								timeMinutes,
								changeRateFromNearest,
							};
						});

						const cornerRelativeToNearest = local.subtract(cornerLocal, stationCenters[0].local);
						const cornerDistanceToNearest = local.magnitude(cornerRelativeToNearest)

						let resize: number[] = [];
						// External boundary of station
						resize.push(stationCenters[0].maxRadius);

						for (let k = 1; k < limiters.length; k++) {
							// traveling T minutes out from current position,
							// we will be at P.
							// the travel-time from nearest will be limiters[0].timeMinutes + T
							// the travel-time from nearest[k] will be limiters[k].timeMinutes + T * limiters[k].changeRateFromNearest
							// limiters[0].timeMinutes + T = limiters[k].timeMinutes + T * limiters[k].changeRateFromNearest
							// when
							// limiters[0].timeMinutes - limiters[k].timeMinutes = T * (limiters[k].changeRateFromNearest - 1)
							const travelMinutes = (limiters[0].timeMinutes - limiters[k].timeMinutes) / (limiters[k].changeRateFromNearest - limiters[0].changeRateFromNearest);
							const travelDistance = travelMinutes * p.speedKmPerMin;
							if (Math.abs(travelDistance) < p.boxKm) {
								resize.push(cornerDistanceToNearest + travelDistance);
							}
						}

						const filteredResize = resize.filter(x => Math.abs(x - cornerDistanceToNearest) <= 2 * p.boxKm);
						if (filteredResize.length > 0) {
							const adjust = local.scale(
								Math.min(...filteredResize) / cornerDistanceToNearest,
								cornerRelativeToNearest,
							);
							corner.adjusts.push(local.toGlobe(local.add(stationCenters[0].local, adjust)));
						}
					}
				}
			}
		}
	}

	const allCorners = new Map<`${number},${number}`, Coordinate>();
	function adjustedCorner(gx: number, gy: number): Coordinate {
		const key: `${number},${number}` = `${gx},${gy}`;
		const cached = allCorners.get(key);
		if (cached !== undefined) {
			return cached;
		}

		const corner = cornerCoordinate(gx, gy);
		if (corner.adjusts.length === 0) {
			allCorners.set(key, corner.coordinate);
			return corner.coordinate;
		}

		const c = local.toLocal(corner.coordinate);
		let xs = 0;
		let ys = 0;
		for (const adjust of corner.adjusts) {
			const a = local.toLocal(adjust);
			xs += limitedTo(a.xKm, { near: c.xKm, within: 0.50 * p.boxKm });
			ys += limitedTo(a.yKm, { near: c.yKm, within: 0.25 * p.boxKm });
		}
		xs /= corner.adjusts.length;
		ys /= corner.adjusts.length;

		const answer = local.toGlobe({ xKm: xs, yKm: ys });
		allCorners.set(key, answer);
		return answer;
	}

	const cells = [];
	for (const tile of tiles.values()) {
		if (tile.from === null) {
			continue;
		}

		const corners: Coordinate[] = [
			adjustedCorner(tile.tile.gx, tile.tile.gy),
			adjustedCorner(tile.tile.gx + 2, tile.tile.gy),
			adjustedCorner(tile.tile.gx + 2, tile.tile.gy + 1),
			adjustedCorner(tile.tile.gx + 2, tile.tile.gy + 2),
			adjustedCorner(tile.tile.gx, tile.tile.gy + 2),
			adjustedCorner(tile.tile.gx, tile.tile.gy + 1),
		];

		cells.push({
			corners,
			tile: tile.tile,
			arrival: tile.from,
		});
	}
	return { corners: allCorners, cells, debugLines };
}

export function groupAndOutlineTiles<TArrival>(
	grid: { tile: HexTile, arrival: TArrival }[]
): {
	arrival: TArrival,
	tiles: HexTile[],
	boundaries: {
		inside: `${number},${number}`,
		outside: `${number},${number}`,
		fromCorner: `${number},${number}`,
		toCorner: `${number},${number}`,
	}[][],
}[] {
	const index = new Map<`${number},${number}`, { tile: HexTile, arrival: TArrival }>();
	for (const cell of grid) {
		const key: `${number},${number}` = `${cell.tile.gx},${cell.tile.gy}`;
		index.set(key, cell);
	}

	const graph = new class implements SimpleGraph<{ tile: HexTile, arrival: TArrival }> {
		neighbors(node: { tile: HexTile, arrival: TArrival }): { tile: HexTile, arrival: TArrival }[] {
			const tile = node.tile;
			const keys: `${number},${number}`[] = [
				`${tile.gx},${tile.gy - 2}`,
				`${tile.gx + 2},${tile.gy - 1}`,
				`${tile.gx + 2},${tile.gy + 1}`,
				`${tile.gx},${tile.gy + 2}`,
				`${tile.gx - 2},${tile.gy + 1}`,
				`${tile.gx - 2},${tile.gy - 1}`,
			];
			const out = [];
			for (const key of keys) {
				const value = index.get(key);
				if (value !== undefined && value.arrival === node.arrival) {
					out.push(value);
				}
			}
			return out;
		}
	}();

	const patches = components(graph, index.values());
	return patches.map(patch => {
		return {
			arrival: patch[0].arrival,
			tiles: patch.map(x => x.tile),
			boundaries: getPatchBoundarySegments(patch),
		};
	});
}

function getPatchBoundarySegments(patch: { tile: HexTile }[]): {
	inside: `${number},${number}`,
	outside: `${number},${number}`,
	fromCorner: `${number},${number}`,
	toCorner: `${number},${number}`,
}[][] {
	const contained = new Set<`${number},${number}`>();
	for (const { tile } of patch) {
		contained.add(`${tile.gx},${tile.gy}`);
	}

	const outsideEdges: {
		inside: `${number},${number}`,
		outside: `${number},${number}`,
		corners: [`${number},${number}`, `${number},${number}`],
	}[] = [];
	for (const node of patch) {
		const tile = node.tile;
		/**
		 * When following each of the edges, the central cell is kept on the
		 * RIGHT of the edge, and the neighboring cell is kept on the LEFT of
		 * the edge.
		 * ```
		 * +               +---------------+               +
		 * |               |(gx,gy-2)      |               |
		 * +---------------+     N[0]      +---------------+
		 * |(gx-2,gy-1)    |               |(gx+2,gy-1)    |
		 * +     N[5]      0---------------1     N[1]      +
		 * |               |(gx,gy)        |               |
		 * +---------------5               2---------------+
		 * |(gx-2,gy+1)    |               |(gx+2,gy+1)    |
		 * +     N[4]      4---------------3     N[2]      +
		 * |               |(gx,gy+2)      |               |
		 * +---------------+     N[3]      +---------------+
		 * |               |               |               |
		 * +               +---------------+               +
		 * ```
		 */
		const neighbors: [`${number},${number}`, [`${number},${number}`, `${number},${number}`]][] = [
			[`${tile.gx},${tile.gy - 2}`, [`${tile.gx},${tile.gy}`, `${tile.gx + 2},${tile.gy}`]],
			[`${tile.gx + 2},${tile.gy - 1}`, [`${tile.gx + 2},${tile.gy}`, `${tile.gx + 2},${tile.gy + 1}`]],
			[`${tile.gx + 2},${tile.gy + 1}`, [`${tile.gx + 2},${tile.gy + 1}`, `${tile.gx + 2},${tile.gy + 2}`]],
			[`${tile.gx},${tile.gy + 2}`, [`${tile.gx + 2},${tile.gy + 2}`, `${tile.gx},${tile.gy + 2}`]],
			[`${tile.gx - 2},${tile.gy + 1}`, [`${tile.gx},${tile.gy + 2}`, `${tile.gx},${tile.gy + 1}`]],
			[`${tile.gx - 2},${tile.gy - 1}`, [`${tile.gx},${tile.gy + 1}`, `${tile.gx},${tile.gy}`]],
		];
		for (const [neighborTile, corners] of neighbors) {
			if (!contained.has(neighborTile)) {
				outsideEdges.push({
					inside: `${tile.gx},${tile.gy}`,
					outside: neighborTile,
					corners,
				});
			}
		}
	}

	const cornerNeighbors = new Map<`${number},${number}`,
		Map<`${number},${number}`, {
			inside: `${number},${number}`,
			outside: `${number},${number}`,
		}>>();
	for (const outsideEdge of outsideEdges) {
		const c0 = cornerNeighbors.get(outsideEdge.corners[0]) || new Map();
		cornerNeighbors.set(outsideEdge.corners[0], c0);

		const c1 = cornerNeighbors.get(outsideEdge.corners[1]) || new Map();
		cornerNeighbors.set(outsideEdge.corners[1], c1);

		c0.set(outsideEdge.corners[1], { inside: outsideEdge.inside, outside: outsideEdge.outside });
	}

	const graph = new class implements SimpleGraph<`${number},${number}`> {
		neighbors(node: `${number},${number}`): `${number},${number}`[] {
			return [...(cornerNeighbors.get(node) || new Map()).keys()];
		}
	}

	const rings = components(graph, cornerNeighbors.keys());
	return rings.map(ring => {
		const out = [];
		for (let i = 0; i < ring.length; i++) {
			const fromCorner = ring[i];
			const toCorner = ring[(i + 1) % ring.length];
			out.push({
				fromCorner,
				toCorner,
				...cornerNeighbors.get(fromCorner)!.get(toCorner)!,
			});
		}
		return out;
	});
}
