import { components, SimpleGraph } from "./graph";

export type V2 = { x: number, y: number };
export type Circle = { center: V2, radius: number };
export type Arc = {
	circle: Circle,
	theta0: number,
	theta1: number,
	direction: 1 | -1,
};

export function distance(a: V2, b: V2) {
	return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

export function doesCircleContainCircle(a: Circle, b: Circle) {
	const centerDistance = distance(a.center, b.center);
	return centerDistance + b.radius <= a.radius
}

export function doesCircleContainPoint(a: Circle, point: V2) {
	return distance(a.center, point) < a.radius;
}

export function circleCircleIntersections(a: Circle, b: Circle): V2[] {
	const centerDistance = distance(a.center, b.center);
	if (centerDistance <= 0 || centerDistance >= (a.radius + b.radius)) {
		return [];
	}

	//      +
	//     /| \
	// a.r/ |h   \ b.r
	//   /  |       \
	//  +---+---------+
	//    u     cD-u

	const u = (centerDistance ** 2 - b.radius ** 2 + a.radius ** 2) / (2 * centerDistance);

	const h = Math.sqrt(a.radius ** 2 - u ** 2);

	const baUnit = {
		x: (b.center.x - a.center.x) / centerDistance,
		y: (b.center.y - a.center.y) / centerDistance,
	};
	const baOrtho = {
		x: -baUnit.y,
		y: baUnit.x,
	};

	return [
		{
			x: a.center.x + u * baUnit.x + h * baOrtho.x,
			y: a.center.y + u * baUnit.y + h * baOrtho.y,
		},
		{
			x: a.center.x + u * baUnit.x - h * baOrtho.x,
			y: a.center.y + u * baUnit.y - h * baOrtho.y,
		},
	];
}

export function linearCombination(...pairs: [number, V2][]): V2 {
	let x = 0;
	let y = 0;
	for (const [weight, v] of pairs) {
		x += weight * v.x;
		y += weight * v.y;
	}
	return { x, y };
}

function moveToUnitCircle(c: number) {
	return (c + Math.PI * 8) % (Math.PI * 2);
}

function difference(a: number, b: number): number {
	return a - b;
}

export function mergeCirclesIntoArcPaths(circles0: Circle[]): V2[][] {
	const largestRadius = Math.max(1, ...circles0.map(c => c.radius));
	const nearby0 = new Nearby<Circle>(2 * largestRadius + 1);
	for (const circle of circles0) {
		nearby0.add(circle.center, circle);
	}

	const nearby = new Nearby<Circle>(2 * largestRadius + 1);
	const circles = [];
	for (const circle of circles0) {
		let covered = false;
		for (const other of nearby0.queryWithin(circle.center)) {
			if (other !== circle && doesCircleContainCircle(other, circle)) {
				covered = true;
				break;
			}
		}
		if (!covered) {
			nearby.add(circle.center, circle);
			circles.push(circle);
		}
	}

	const out = [];
	for (const circle of circles) {
		const neighbors = [...nearby.queryWithin(circle.center)];
		let contained = false;
		const rotate = 0 * Math.PI / 2;
		const cutThetas = [0, 1, 2, 3, 4, 5, 6, 7].map(q => rotate + q / 8 * Math.PI * 2);
		const cuttingNeighbors = new Set<Circle>();
		for (const neighbor of neighbors) {
			if (neighbor === circle) {
				continue;
			}

			if (doesCircleContainCircle(neighbor, circle)) {
				contained = true;
				break;
			} else if (doesCircleContainCircle(circle, neighbor)) {
				continue;
			}

			const cuts = circleCircleIntersections(circle, neighbor);
			for (const cut of cuts) {
				cutThetas.push(Math.atan2(
					cut.y - circle.center.y,
					cut.x - circle.center.x,
				));
				cuttingNeighbors.add(neighbor);
			}
		}

		if (contained) {
			// TODO: For showing source paths, we _may_ want to relax this in
			// the future.
			continue;
		}

		const allCuts = [...new Set(cutThetas.map(moveToUnitCircle).sort(difference))];

		const arcs: Arc[] = [];
		for (let i = 0; i < allCuts.length; i++) {
			const a = allCuts[i];
			const b = allCuts[(i + 1) % allCuts.length];

			const midpointDirection = {
				x: (Math.cos(a) + Math.cos(b)) / 2,
				y: (Math.sin(a) + Math.sin(b)) / 2,
			};
			const midpointDirectionMagitude = Math.sqrt(
				midpointDirection.x ** 2 + midpointDirection.y ** 2
			);
			const midpoint = {
				x: circle.center.x + circle.radius / midpointDirectionMagitude * midpointDirection.x,
				y: circle.center.y + circle.radius / midpointDirectionMagitude * midpointDirection.y,
			};

			let isInside = false;
			for (const cuttingNeighbor of cuttingNeighbors) {
				if (doesCircleContainPoint(cuttingNeighbor, midpoint)) {
					isInside = true;
					break;
				}
			}

			if (!isInside) {
				arcs.push({
					circle,
					theta0: a,
					theta1: b,
					direction: 1,
				});
			}
		}

		if (arcs.length !== 0) {
			out.push(arcs);
		}
	}

	const identities = new Nearby<V2>(0.00001);
	function identify(p: V2): V2 {
		const e = identities.queryWithin(p);
		if (e.length !== 0) {
			return e[0];
		}
		identities.add(p, p);
		return p;
	}

	const edges = new Map<V2, { arcCenter: V2, other: V2 }[]>();
	for (const arc of out.flat()) {
		const [p0, p1] = [arc.theta0, arc.theta1].map(theta => {
			return {
				x: arc.circle.center.x + arc.circle.radius * Math.cos(theta),
				y: arc.circle.center.y + arc.circle.radius * Math.sin(theta),
			};
		});

		const i0 = identify(p0);
		const i1 = identify(p1);
		const e0 = edges.get(i0) || [];
		const e1 = edges.get(i1) || [];

		e0.push({
			arcCenter: arc.circle.center,
			other: i1,
		});
		e1.push({
			arcCenter: arc.circle.center,
			other: i0,
		});

		edges.set(i0, e0);
		edges.set(i1, e1);
	}

	const cs = components(new class implements SimpleGraph<V2> {
		neighbors(node: V2): V2[] {
			return edges.get(node)!.map(x => x.other);
		}
	}, edges.keys());

	return cs;
}

class Nearby<T> {
	private map: Map<number, { point: V2, thing: T }[]> = new Map();

	constructor(
		private boxSize: number,
	) { }

	private tile(point: V2) {
		const u = Math.abs(Math.floor(point.x / this.boxSize));
		const v = Math.abs(Math.floor(point.y / this.boxSize));
		return { u, v };
	}

	private key(tu: number, tv: number): number {
		return tu + tv * 1337;
	}

	add(point: V2, thing: T): void {
		const item = { point, thing };
		const { u: pu, v: pv } = this.tile(point);
		const key = this.key(pu, pv);
		const group = this.map.get(key);
		if (group === undefined) {
			this.map.set(key, [item]);
		} else {
			group.push(item);
		}
		this.cache.clear();
	}

	private cache = new Map<number, T[]>();

	queryWithin(point: V2): readonly T[] {
		const { u: pu, v: pv } = this.tile(point);
		const mainKey = this.key(pu, pv);
		const cached = this.cache.get(mainKey);
		if (cached !== undefined) {
			return cached;
		}

		const out = [];
		for (let u = pu - 1; u <= pu + 1; u++) {
			for (let v = pv - 1; v <= pv + 1; v++) {
				const group = this.map.get(this.key(u, v));
				if (!group) {
					continue;
				}
				for (const item of group) {
					out.push(item.thing);
				}
			}
		}

		this.cache.set(mainKey, out);
		return out;
	}
}
