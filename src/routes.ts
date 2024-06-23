import { dijkstras } from "./search";
import { timed } from "./timer";

export async function renderRoutes(
	matrices: Matrices,
	walking: [number, number][][],
	startStationOffset: number,
): Promise<ParentEdge[]> {
	const parentEdges = await timed("disjkstras", async () => {
		return dijkstras(matrices.matrices[0], walking, startStationOffset, matrices)
			.map((v, i) => ({ ...v, i }));
	});
	return parentEdges;
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
