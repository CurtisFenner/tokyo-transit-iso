export const kantoBox = [
	138.8260,
	35.2400,
	140.9821,
	36.1944,
];

function nominatumSearchURL(q: string) {
	const base = "https://nominatim.openstreetmap.org/search";
	return `${base}?q=${encodeURI(q)}&viewbox=${kantoBox.join(",")}&format=json&limit=10`;
}

export async function searchForPlace(q: string): Promise<{
	coordinate: Coordinate,
	shortName: string,
	fullName: string,
}[]> {
	const url = nominatumSearchURL(q);
	const response = await fetch(url);
	const json = await response.json();
	return json.map((place: any) => {
		return {
			coordinate: { lat: place.lat, lon: place.lon } satisfies Coordinate,
			shortName: place.name,
			fullName: place.display_name,
		};
	});
}
