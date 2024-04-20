import * as images from "./images";
import { dijkstras, formatTime } from "./search";
import { timed } from "./timer";

export async function renderRoutes(
	matrices: Matrices,
	walking: [number, number][][],
	startStationOffset: number,
	lineLogos: Array<images.LogoRect | undefined>,
): Promise<{ table: HTMLTableElement, parentEdges: ParentEdge[] }> {
	const beforeDijkstras = performance.now();
	const parentEdges = await timed("disjkstras", async () => {
		return dijkstras(matrices.matrices[0], walking, startStationOffset, matrices)
			.map((v, i) => ({ ...v, i }));
	});
	const afterDijkstras = performance.now();
	console.log(afterDijkstras - beforeDijkstras, "ms dijkstras");

	const table = document.createElement("table");
	for (const v of parentEdges.filter(x => x && x.time < 60 * 2.5).sort((a, b) => a.time - b.time)) {
		const row = renderRouteLine(matrices, lineLogos, v, parentEdges);
		table.appendChild(row);
	}
	return { table, parentEdges };
}

type ParentEdge = {
	i: number;
	time: number;
	parent: {
		via: "walk";
		from: number;
	} | {
		via: "train";
		train: MatrixDistance;
		from: number;
	} | null;
};

function renderRouteLine(
	matrices: Matrices,
	lineLogos: Array<images.LogoRect | undefined>,
	v: ParentEdge,
	parentEdges: {
		i: number;
		time: number;
		parent: {
			via: "walk";
			from: number;
		} | {
			via: "train";
			train: MatrixDistance;
			from: number;
		} | null;
	}[],
): HTMLElement {
	const i = v.i;
	const row = document.createElement("tr");
	const th = document.createElement("th");
	const station = matrices.stations[i];
	th.textContent = station.name;
	row.appendChild(th);
	const timeTd = document.createElement("td");
	timeTd.textContent = formatTime(v.time);
	row.appendChild(timeTd);
	const routeTd = document.createElement("td");
	let node = v;
	let iterations = 0;
	while (node) {
		routeTd.prepend(document.createTextNode("@ " + formatTime(node.time)));
		const station = document.createElement("span");
		station.textContent = matrices.stations[node.i].name;
		station.className = "station";
		routeTd.prepend(station);

		if (!node.parent) {
			break;
		}
		if (node.parent.via === "train") {
			const trainDescription = node.parent.train.route[0];
			const trainSpan = document.createElement("span");
			trainSpan.className = "train";

			let lineLogo = undefined;

			if (!trainDescription) {
				trainSpan.textContent = ("ERROR");
			} else {
				trainSpan.setAttribute("data-train-route", JSON.stringify(node.parent.train.route));
				const trainLine = matrices.lines[trainDescription.line || -1]
				lineLogo = lineLogos[trainDescription.line || -1];
				const lineName = trainLine?.name;
				const serviceName = trainDescription.service;

				trainSpan.textContent = lineName + (
					serviceName
						? " [" + serviceName + "]"
						: "");
			}
			routeTd.prepend(trainSpan);

			if (lineLogo) {
				trainSpan.style.backgroundColor = images.toCSSColor(lineLogo.color);
				trainSpan.style.color = images.contrastingColor(lineLogo.color);
			}

		} else {
			routeTd.prepend("walk");
		}

		node = parentEdges[node.parent.from];

		iterations += 1;
		if (iterations > 100) {
			throw new Error("excessive iterations!");
		}
	}
	row.appendChild(routeTd);
	return row;
}
