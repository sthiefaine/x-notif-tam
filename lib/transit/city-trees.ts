import type { FeatureCollection, Polygon } from "geojson";
import type { GeoJSONSource, Map as LibreMap } from "maplibre-gl";

const SOURCE = "montpellier-illustrated-trees";
const LAYER = "montpellier-illustrated-tree-volumes";
const LIMIT = 1800;

function crown(lon: number, lat: number, radius: number): Polygon {
  const coordinates: number[][] = [];
  for (let i = 0; i <= 10; i++) {
    const angle = i / 10 * Math.PI * 2;
    coordinates.push([lon + Math.cos(angle) * radius / (111320 * Math.cos(lat * Math.PI / 180)), lat + Math.sin(angle) * radius / 111320]);
  }
  return { type: "Polygon", coordinates: [coordinates] };
}

/** Inventory positions are real; crown dimensions and colours are illustrative. */
export function addIllustratedCityTrees(map: LibreMap): () => void {
  const controller = new AbortController();
  let points: [number, number][] = [], disposed = false;
  const timer = setTimeout(() => controller.abort(), 12_000);
  const refresh = () => {
    if (disposed || !map.getSource(SOURCE)) return;
    const features: FeatureCollection<Polygon>["features"] = [];
    if (map.getZoom() >= 16) {
      const bounds = map.getBounds(), center = map.getCenter();
      const visible = points.filter(([lon, lat]) => bounds.contains([lon, lat]));
      if (visible.length > LIMIT) visible.sort((a, b) => (a[0] - center.lng) ** 2 + (a[1] - center.lat) ** 2 - (b[0] - center.lng) ** 2 - (b[1] - center.lat) ** 2);
      for (const [lon, lat] of visible.slice(0, LIMIT)) {
        const seed = Math.abs(Math.sin(lon * 1337 + lat * 7919));
        const radius = 2.1 + seed * .6;
        const green = ["#759554", "#85a35c", "#6d914f"][Math.floor(seed * 3) % 3];
        for (const [r, base, height, color] of [[.16, 0, 4.8, "#8c7960"], [radius * .7, 3.8, 4.7, green], [radius, 4.7, 6.1, green], [radius * .65, 6.1, 7.3, green]] as const) {
          features.push({ type: "Feature", properties: { base, height, color }, geometry: crown(lon, lat, r) });
        }
      }
    }
    (map.getSource(SOURCE) as GeoJSONSource).setData({ type: "FeatureCollection", features });
  };
  map.addSource(SOURCE, { type: "geojson", data: { type: "FeatureCollection", features: [] }, attribution: '<a href="https://data.montpellier3m.fr/dataset/arbres-dalignement-de-montpellier" target="_blank" rel="noopener noreferrer">Arbres © Montpellier Méditerranée Métropole · ODbL</a>' });
  map.addLayer({ id: LAYER, type: "fill-extrusion", source: SOURCE, paint: { "fill-extrusion-color": ["get", "color"], "fill-extrusion-base": ["get", "base"], "fill-extrusion-height": ["get", "height"], "fill-extrusion-opacity": 1, "fill-extrusion-vertical-gradient": true } });
  map.on("moveend", refresh);
  void fetch("/city/trees.json", { signal: controller.signal }).then(async response => {
    if (!response.ok || Number(response.headers.get("Content-Length")) > 4 * 1024 * 1024) return;
    const value = await response.json() as { positions?: unknown };
    if (disposed || !Array.isArray(value.positions) || value.positions.length > 100000) return;
    points = value.positions.filter((p): p is [number, number] => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite) && p[0] >= 3.7 && p[0] <= 4.1 && p[1] >= 43.4 && p[1] <= 43.8);
    refresh();
  }).catch(() => { /* Building geometry remains usable if vegetation is unavailable. */ }).finally(() => clearTimeout(timer));
  return () => { disposed = true; controller.abort(); clearTimeout(timer); map.off("moveend", refresh); points = []; };
}
