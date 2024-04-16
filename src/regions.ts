import { LocalCoordinate, LocalPlane, earthGreatCircleDistanceKm, geoMidpoint } from "./geometry";
import * as spatial from "./spatial";

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
		boxSize: number,
		maxRadiusKm: number,
		maxMinutes: number,
		speedKmPerMin: number,
	},
): Promise<{ cells: { corners: Coordinate[], arrival: TArrival }[], debugLines: Coordinate[][] }> {
	const spatialArrivals = new spatial.Spatial<TArrival>(12);
	for (const arrival of arrivals) {
		spatialArrivals.add(arrival);
	}

	const local = LocalPlane.nearPoint(arrivals[0].coordinate);

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
			xKm: gx * p.boxSize / 2 + (0) * p.boxSize / 6,
			yKm: gy * p.boxSize / 2 + (0) * p.boxSize / 6,
		};
		const out = { coordinate: local.toGlobe(c), adjusts: [] };
		cornerCache.set(key, out);
		return cornerCoordinate(gx, gy);
	}

	function adjustedCorner(gx: number, gy: number): Coordinate {
		const corner = cornerCoordinate(gx, gy);
		if (corner.adjusts.length === 0) {
			return corner.coordinate;
		}

		const c = local.toLocal(corner.coordinate);
		let xs = 0;
		let ys = 0;
		for (const adjust of corner.adjusts) {
			const a = local.toLocal(adjust);
			xs += limitedTo(a.xKm, { near: c.xKm, within: 0.50 * p.boxSize });
			ys += limitedTo(a.yKm, { near: c.yKm, within: 0.25 * p.boxSize });
		}
		xs /= corner.adjusts.length;
		ys /= corner.adjusts.length;

		const answer = local.toGlobe({ xKm: xs, yKm: ys });
		return answer;
	}

	const grid: HexGrid = {
		boxSize: p.boxSize,
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
						const tileCorner = local.add(tile.topLeft, { xKm: (u * 0.25 + 0.5) * p.boxSize, yKm: (v * 0.25 + 0.5) * p.boxSize });
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
							if (Math.abs(travelDistance) < p.boxSize) {
								resize.push(cornerDistanceToNearest + travelDistance);
							}
						}

						const filteredResize = resize.filter(x => Math.abs(x - cornerDistanceToNearest) <= 2 * p.boxSize);
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
			arrival: tile.from,
		});
	}
	return { cells, debugLines };
}

export function neighboringRivals<H>(
	arrivals: Arrival[],
	metric: Metric<H>,
	p: {
		maxRadiusKm: number,
		speedKmPerMin: number,
	},
) {
	const spatialArrivals = new spatial.Spatial<Arrival>(12);
	for (const arrival of arrivals) {
		spatialArrivals.add(arrival);
	}

	const out = [];
	for (const arrival of arrivals) {
		const divisions = [];
		for (const neighbor of spatialArrivals.nearby(arrival.coordinate, p.maxRadiusKm)) {
			if (neighbor === arrival) {
				continue;
			}

			const plane = LocalPlane.nearPoint(geoMidpoint(arrival.coordinate, neighbor.coordinate));
			const time = Math.max(arrival.arrivalMinutes, neighbor.arrivalMinutes);
			const a: LocalCircle = {
				center: plane.toLocal(arrival.coordinate),
				radiusKm: (time - arrival.arrivalMinutes) * p.speedKmPerMin,
			};
			const b: LocalCircle = {
				center: plane.toLocal(neighbor.coordinate),
				radiusKm: (time - neighbor.arrivalMinutes) * p.speedKmPerMin,
			};

			const division = metric.describeNearestRegion(plane, a, b);
			divisions.push({ division, neighbor });
		}
		out.push({
			arrival,
			divisions,
		});
	}
}

interface Metric<H> {
	describeNearestRegion(plane: LocalPlane, a: LocalCircle, b: LocalCircle): H
}

class AngledMetric implements Metric<unknown> {
	private angleGap: number;

	constructor(
		private n: number,
	) {
		if (n % 2 !== 0 || n < 4) {
			throw new Error(`new AngledMetric: invalid n ${n}`);
		}

		this.angleGap = Math.PI * 2 / n;
	}

	distance(plane: LocalPlane, a: LocalCoordinate, b: LocalCoordinate): number {
		const motion = plane.subtract(a, b);
		const fractionTheta = Math.abs(Math.atan2(motion.yKm, motion.xKm)) % this.angleGap;

		return plane.distanceKm(a, b) * (
			Math.sin(fractionTheta) / Math.sin(this.angleGap)
			+ Math.cos(fractionTheta)
			- Math.sin(fractionTheta) / Math.tan(this.angleGap)
		);
	}

	describeNearestRegion(plane: LocalPlane, a: LocalCircle, b: LocalCircle): unknown {
		const centerDistance = this.distance(plane, a.center, b.center);
		const remainingGap = centerDistance - a.radiusKm + b.radiusKm;
		if (remainingGap < 0) {
			// One of the circles contains the other.
			return null;
		}

		throw new Error("Method not implemented.");
	}
}
