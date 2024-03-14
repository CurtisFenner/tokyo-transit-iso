type Color = { r: number, g: number, b: number };

const imageColorCache: Record<string, Color> = {};

type Rect = { left: number, right: number, top: number, bottom: number };

async function fetchLogoAtlasRectangles(): Promise<Record<string, Rect>> {
	const f = await fetch("wikidata/logos.json");
	return await f.json();
}

function imagePromise(src: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const img = document.createElement("img");
		img.src = src;
		img.onload = () => resolve(img);
		img.onerror = reject;
	});
}

async function getImageColor(image: HTMLImageElement): Promise<Color> {
	const existing = imageColorCache[image.src];
	if (existing) {
		return existing;
	}

	// Wait until the image is loaded.
	await new Promise((resolve, reject) => {
		if (image.complete) {
			resolve(image);
		} else {
			image.onload = () => resolve(image);
			image.onerror = e => reject(e);
		}
	});

	const canvas = document.createElement("canvas");
	canvas.width = 80;
	canvas.height = 80;
	const ctx = canvas.getContext("2d");
	if (!ctx) {
		throw new Error("canvas is not supported");
	}

	ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

	try {
		const srgb = ctx.getImageData(0, 0, canvas.width, canvas.height, { colorSpace: "srgb" });

		let rs = 0;
		let gs = 0;
		let bs = 0;
		let ws = 0;
		for (let i = 0; i < srgb.data.length; i += 4) {
			const r = srgb.data[i];
			const g = srgb.data[i + 1];
			const b = srgb.data[i + 2];
			const a = srgb.data[i + 3];

			const saturation = Math.max(r, g, b) - Math.min(r, g, b);
			const weight = saturation * a;
			ws += weight;
			rs += r * weight;
			gs += g * weight;
			bs += b * weight;
		}

		const out = {
			r: Math.round(rs / ws),
			g: Math.round(gs / ws),
			b: Math.round(bs / ws),
		};
		imageColorCache[image.src] = out;
		return out;
	} catch (e) {
		console.error("could not load:", e);
		return { r: 0, g: 0, b: 0 };
	}
}

function contrastingColor(color: Color): "#000" | "#FFF" {
	const average = color.r * 0.21 + color.g + 0.72 + 0.07 * color.b;
	if (average < 150) {
		return "#FFF";
	}
	return "#000";
}

function toCSSColor(color: Color) {
	return `rgb(${Math.round(color.r)}, ${Math.round(color.g)}, ${Math.round(color.b)})`;
}
