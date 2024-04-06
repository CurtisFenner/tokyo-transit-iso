function toTile(zoom: number, coordinate: Coordinate): {
    x: number, y: number,
    ix: number, iy: number,
} {
    const x3857 = coordinate.lon;
    const latRad = coordinate.lat * Math.PI / 180;
    const y3857 = Math.log(Math.tan(latRad) + 1 / Math.cos(latRad));
    const x = 0.5 + x3857 / 360;
    const y = 0.5 - y3857 / (2 * Math.PI);
    const n = 2 ** zoom;
    return {
        x: n * x,
        y: n * y,
        ix: Math.floor(n * x),
        iy: Math.floor(n * y),
    };
}

class Spatial<T extends { coordinate: Coordinate }> {
    constructor(private zoom: number) { }
    private grid = new Map<string, T[]>();

    add(t: T) {
        const { ix, iy } = toTile(this.zoom, t.coordinate);
        const tileID = `${ix}/${iy}`;
        const tile = this.grid.get(tileID) || [];
        tile.push(t);
        this.grid.set(tileID, tile);
    }

    neighborhoodOf(query: Coordinate, radius = 1) {
        const { ix, iy } = toTile(this.zoom, query);
        const out: T[] = [];
        for (let u = -radius; u <= radius; u++) {
            for (let v = -radius; v <= radius; v++) {
                const neighbor = `${ix + u}/${iy + v}`;
                const grid = this.grid.get(neighbor);
                if (grid !== undefined) {
                    out.push(...grid);
                }
            }
        }
        return out;
    }

    nearby(query: Coordinate, radiusKm: number): T[] {
        return this.neighborhoodOf(query).filter(x => earthGreatCircleDistanceKm(x.coordinate, query) < radiusKm);
    }
}
