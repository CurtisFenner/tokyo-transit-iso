import { MinHeap } from "./data/heap";
import { earthGreatCircleDistanceKm, STANDARD_WALKING_SPEED_KPH } from "./geometry";
import { ArrivalTime } from "./search";
import { TransitData } from "./transit-data";

export type PathEdge = {
	tag: "walking"
} | {
	tag: "train",
	train: { label: TrainLabel, from: StationOffset },
};

type Reachable = { arrivalTime: ArrivalTime, edge: PathEdge };

export class Pathfinder<K> {
	constructor(
		private transitData: TransitData,
		private landmarks: Map<K, Coordinate>,
		private options: {
			maxWalkMinutes: number,
			maxJourneyMinutes: number,
			trainTransferPenaltyMinutes: number,
			transferWalkingPenaltyMinutes: number,
		},
	) { }

	pathfindFrom(from: Coordinate): Map<K | StationOffset, Reachable> {
		const shortestPath = new Map<StationOffset, Reachable>(
			[...this.transitData.walkingData.nearby(from)].filter(value => {
				const walkingTimeLimitMinutes = Math.min(
					this.options.maxWalkMinutes,
					this.options.maxJourneyMinutes,
				);
				return value.timeMinutes < walkingTimeLimitMinutes;
			}).map(value => {
				return [value.stationID, {
					arrivalTime: {
						coordinate: this.transitData.stations[value.stationID].coordinate,
						arrivalMinutes: value.timeMinutes,
						finalWalkingLegMinutes: value.timeMinutes,
					},
					edge: { tag: "walking" },
				}];
			}),
		);

		const traversalOrder = new MinHeap<{ stationOffset: StationOffset, arrival: ArrivalTime }>((a, b) => {
			return a.arrival.arrivalMinutes < b.arrival.arrivalMinutes ? "<" : ">";
		});
		for (const [stationOffset, arrival] of shortestPath) {
			traversalOrder.push({ stationOffset, arrival: arrival.arrivalTime });
		}

		const pushNeighborArrival = (at: StationOffset, arrival: ArrivalTime, edge: PathEdge) => {
			if (arrival.arrivalMinutes > this.options.maxJourneyMinutes
				|| arrival.finalWalkingLegMinutes > this.options.maxWalkMinutes) {
				return;
			}

			const previousBest = shortestPath.get(at);
			if (previousBest === undefined || previousBest.arrivalTime.arrivalMinutes > arrival.arrivalMinutes) {
				shortestPath.set(at, { arrivalTime: arrival, edge });
				traversalOrder.push({ stationOffset: at, arrival });
			}
		}

		while (traversalOrder.size() !== 0) {
			const top = traversalOrder.pop();
			if (top.arrival.arrivalMinutes > shortestPath.get(top.stationOffset)!.arrivalTime.arrivalMinutes) {
				continue;
			}

			// Train neighbors
			for (const trainNeighbor of this.transitData.trainOutEdges[top.stationOffset]) {
				if (!trainNeighbor.minutes) {
					// A null or 0 should be ignored.
					continue;
				}

				const trainTime = trainNeighbor.minutes.avg + this.options.trainTransferPenaltyMinutes;

				const neighborArrival: ArrivalTime = {
					coordinate: this.transitData.stations[trainNeighbor.to].coordinate,
					arrivalMinutes: top.arrival.arrivalMinutes + trainTime,
					finalWalkingLegMinutes: 0,
				};

				pushNeighborArrival(trainNeighbor.to, neighborArrival, {
					tag: "train",
					train: {
						from: top.stationOffset,
						label: trainNeighbor.route[0],
					},
				});
			}

			// Walking neighbors
			if (top.arrival.finalWalkingLegMinutes > 0) {
				continue;
			}
			for (const walkingNeighbor of this.transitData.walkingData.matrix[top.stationOffset]) {
				const walkTime = walkingNeighbor.minutes + this.options.transferWalkingPenaltyMinutes;
				const walkingArrival: ArrivalTime = {
					coordinate: this.transitData.stations[walkingNeighbor.to].coordinate,
					arrivalMinutes: top.arrival.arrivalMinutes + walkTime,
					finalWalkingLegMinutes: walkTime,
				};
				pushNeighborArrival(walkingNeighbor.to, walkingArrival, { tag: "walking" });
			}
		}

		// Walk to each landmark.
		const landmarkPaths = new Map<K, Reachable>();
		for (const [landmark, landmarkCoordinate] of this.landmarks) {
			const walkFromFromMinutes = walkingMinutesBetween(from, landmarkCoordinate);
			let shortestWalk: ArrivalTime = {
				arrivalMinutes: walkFromFromMinutes,
				finalWalkingLegMinutes: walkFromFromMinutes,
				coordinate: landmarkCoordinate,
			};

			for (const reached of shortestPath.values()) {
				if (reached.arrivalTime.finalWalkingLegMinutes > 0) {
					// Instead, walk from the nearest non-walking arrival.
					continue;
				}
				const walkTime =
					walkingMinutesBetween(reached.arrivalTime.coordinate, landmarkCoordinate) + this.options.transferWalkingPenaltyMinutes;
				const walkingArrival: ArrivalTime = {
					arrivalMinutes: reached.arrivalTime.arrivalMinutes,
					finalWalkingLegMinutes: reached.arrivalTime.finalWalkingLegMinutes + walkTime,
					coordinate: landmarkCoordinate,
				};
				if (walkingArrival.arrivalMinutes < shortestWalk.arrivalMinutes && walkTime < this.options.maxWalkMinutes) {
					shortestWalk = walkingArrival;
				}
			}
			if (shortestWalk.arrivalMinutes < this.options.maxJourneyMinutes && shortestWalk.finalWalkingLegMinutes < this.options.maxWalkMinutes) {
				landmarkPaths.set(landmark, { arrivalTime: shortestWalk, edge: { tag: "walking" } });
			}
		}

		return new Map<K | StationOffset, Reachable>([...landmarkPaths, ...shortestPath]);
	}
}

export function walkingArrivalsMinutes(
	transitData: TransitData,
	source: Coordinate,
	options: {
		maxWalkMinutes: number,
		maxJourneyMinutes: number,
	},
): Map<StationOffset, number> {
	const arrivals = new Map<StationOffset, number>();
	for (const [stationOffset, matrixStation] of transitData.walkingData.stationCoordinates) {
		const walkingMinutes = walkingMinutesBetween(source, matrixStation.coordinate);
		if (walkingMinutes < Math.min(options.maxWalkMinutes, options.maxJourneyMinutes)) {
			arrivals.set(stationOffset, walkingMinutes);
		}
	}
	return arrivals;
}

function walkingMinutesBetween(a: Coordinate, b: Coordinate): number {
	const distance = earthGreatCircleDistanceKm(a, b);
	return 60 * distance / STANDARD_WALKING_SPEED_KPH;;
}

export function blendArrivals(weightedArrivals: Map<ArrivalTime, number>): ArrivalTime {
	if (weightedArrivals.size === 0) {
		throw new Error();
	}

	const first = [...weightedArrivals][0][0];

	let weightedSquareSum = 0;
	let weightSum = 0;
	let weightedWalkSquareSum = 0;
	for (const [arrival, weight] of weightedArrivals) {
		weightedSquareSum += weight * (arrival.arrivalMinutes ** 2);
		weightedWalkSquareSum += weight * (arrival.finalWalkingLegMinutes ** 2);
		weightSum += weight;
	}

	const blendedArrivalMinutes = Math.sqrt(weightedSquareSum / weightSum);
	const blendedFinalWalkingLegMinutes = Math.min(
		Math.sqrt(weightedWalkSquareSum / weightSum),
		blendedArrivalMinutes,
	);

	return {
		coordinate: first.coordinate,
		arrivalMinutes: blendedArrivalMinutes,
		finalWalkingLegMinutes: blendedFinalWalkingLegMinutes,
	};
}
