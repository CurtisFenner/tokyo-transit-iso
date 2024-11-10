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
		linearCombination([1, a.center], [u, baUnit], [h, baOrtho]),
		linearCombination([1, a.center], [u, baUnit], [-h, baOrtho]),
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
		for (const other of nearby0.queryWithin(circle.center, largestRadius + circle.radius)) {
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
		const neighbors = [...nearby.queryWithin(circle.center, circle.radius + largestRadius)];
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

		const allCuts = [...new Set(
			cutThetas.map(c => (c + Math.PI * 8) % (Math.PI * 2))
				.sort((a, b) => a - b)
		)];

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
			const midpoint = linearCombination(
				[1, circle.center],
				[circle.radius / midpointDirectionMagitude, midpointDirection],
			);

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

	const identities = new Nearby<V2>(0.001);
	function identify(p: V2): V2 {
		const e = [...identities.queryWithin(p, 0.001)];
		if (e.length !== 0) {
			return e[0];
		}
		identities.add(p, p);
		return p;
	}

	const edges = new Map<V2, { arcCenter: V2, other: V2 }[]>();
	for (const arc of out.flat()) {
		const [p0, p1] = [arc.theta0, arc.theta1].map(theta => {
			return linearCombination(
				[1, arc.circle.center],
				[arc.circle.radius, { x: Math.cos(theta), y: Math.sin(theta) }],
			);
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
	}

	* queryWithin(point: V2, radius: number): Generator<T> {
		const { u: pu, v: pv } = this.tile(point);
		for (let u = pu - 1; u <= pu + 1; u++) {
			for (let v = pv - 1; v <= pv + 1; v++) {
				const group = this.map.get(this.key(u, v));
				if (!group) {
					continue;
				}
				for (const item of group) {
					if (distance(item.point, point) < radius) {
						yield item.thing;
					}
				}
			}
		}
	}
}

const canvas = document.createElement("canvas");
canvas.width = 1600;
canvas.height = 800;
canvas.style.position = "fixed";
canvas.style.top = "5rem";
canvas.style.left = "5rem";
canvas.style.border = "3px solid gray";
// canvas.style.background = "white";
// document.body.appendChild(canvas);

const ctx = canvas.getContext("2d")!;

function drawArc(ctx: CanvasRenderingContext2D, arc: Arc) {
	const forwardDistance = (arc.theta1 + Math.PI * 2 - arc.theta0) % (Math.PI * 2);
	const backwardDistance = (arc.theta0 + Math.PI * 2 - arc.theta1) % (Math.PI * 2);
	// ctx.arc(arc.circle.center.x, arc.circle.center.y, arc.circle.radius, arc.theta0, arc.theta1, backwardDistance > forwardDistance);

	const p0 = linearCombination(
		[1, arc.circle.center],
		[arc.circle.radius, {
			x: Math.cos(arc.theta0),
			y: Math.sin(arc.theta0),
		}],
	);
	const p1 = linearCombination(
		[1, arc.circle.center],
		[arc.circle.radius, {
			x: Math.cos(arc.theta1),
			y: Math.sin(arc.theta1),
		}],
	);

	ctx.moveTo(p0.x, p0.y);
	ctx.lineTo(p1.x, p1.y);
}

function drawCircle(ctx: CanvasRenderingContext2D, circle: Circle) {
	ctx.moveTo(circle.center.x + circle.radius, circle.center.y);
	ctx.arc(circle.center.x, circle.center.y, circle.radius, 0, Math.PI * 2);
}

const inputs: Circle[] = [
	{
		center: { x: 300, y: 400 },
		radius: 300,
	}, {
		center: { x: 350, y: 400 },
		radius: 300,
	},
];

for (const input of inputs) {
	ctx.lineWidth = 20;
	ctx.strokeStyle = "#DDD";
	ctx.beginPath();
	drawCircle(ctx, input);
	ctx.stroke();
}

const merged = mergeCirclesIntoArcPaths(inputs);
for (let i = 0; i < merged.length; i++) {
	ctx.beginPath();
	ctx.lineWidth = 2;
	const hue = 360 * i / (merged.length);
	ctx.strokeStyle = `hsl(${hue.toFixed(0)}deg 100% 50%)`;

	ctx.beginPath();
	ctx.moveTo(merged[i][0].x, merged[i][0].y);
	for (let k = 1; k < merged[i].length; k++) {
		ctx.lineTo(merged[i][k].x, merged[i][k].y);
	}
	ctx.closePath();
	ctx.stroke();

	// ctx.fillStyle = ctx.strokeStyle;
	// for (const arc of merged[i]) {
	// 	ctx.beginPath();
	// 	for (const theta of [arc.theta0, arc.theta1]) {
	// 		const p = linearCombination(
	// 			[1, arc.circle.center],
	// 			[arc.circle.radius, {
	// 				x: Math.cos(theta),
	// 				y: Math.sin(theta),
	// 			}],
	// 		);
	// 		ctx.moveTo(p.x, p.y);
	// 		ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
	// 	}
	// 	ctx.fill();
	// }
}
