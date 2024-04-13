export class MinHeap<T> {
	private array: T[] = [];

	constructor(
		private cmp: (a: T, b: T) => "<" | ">",
	) { }

	private fixdown(i: number): void {
		let smallest = i;
		const left = 2 * i + 1;
		const right = 2 * i + 2;

		if (left < this.array.length && this.cmp(this.array[left], this.array[smallest]) === "<") {
			smallest = left;
		}

		if (right < this.array.length && this.cmp(this.array[right], this.array[smallest]) === "<") {
			smallest = right;
		}

		if (smallest !== i) {
			[this.array[i], this.array[smallest]] = [this.array[smallest], this.array[i]];
			this.fixdown(smallest);
		}
	}

	private fixup(i: number): void {
		while (i > 0) {
			const parent = Math.floor((i - 1) / 2);
			if (this.cmp(this.array[i], this.array[parent]) === ">") {
				break;
			}
			[this.array[i], this.array[parent]] = [this.array[parent], this.array[i]];
			i = parent;
		}
	}

	push(t: T) {
		this.array.push(t);
		this.fixup(this.array.length - 1);
	}

	size() {
		return this.array.length;
	}

	pop(): T {
		const out = this.array[0];
		const last = this.array.pop();
		if (last === undefined) {
			throw new Error("MinHeap.pop: cannot pop from empty heap");
		}

		if (this.array.length !== 0) {
			this.array[0] = last;
			this.fixdown(0);
		}
		return out;
	}
}
