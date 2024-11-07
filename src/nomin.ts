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
	const results: {
		coordinate: Coordinate,
		shortName: string,
		fullName: string,
	}[] = json.map((place: any) => {
		return {
			coordinate: { lat: place.lat * 1, lon: place.lon * 1 } satisfies Coordinate,
			shortName: place.name,
			fullName: place.display_name,
		};
	});

	return results.filter(place => {
		return kantoBox[0] <= place.coordinate.lon && place.coordinate.lon <= kantoBox[2]
			&& kantoBox[1] <= place.coordinate.lat && place.coordinate.lat <= kantoBox[3];
	});
}
