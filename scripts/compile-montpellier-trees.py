#!/usr/bin/env python3
"""Compile official tree positions inside the municipal GeoJSON, without GIS deps.

Example (raw cache deliberately outside the repository):
  python3 scripts/compile-montpellier-trees.py --download

Only lon/lat are published; dimensions and species are not inferred. Coordinates
are rounded to seven decimals, then checked again against the same boundary.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import stat
import tempfile
import time
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
SOURCE_URL = "https://data.montpellier3m.fr/sites/default/files/ressources/MMM_MTP_Arbres.json"
SOURCE_TITLE = "Arbres de Montpellier — Montpellier Méditerranée Métropole"
MAX_SOURCE_BYTES = 40 * 1024 * 1024
SQUARE_BBOX = (3.879, 43.604, 3.8815, 43.6058)


def within(path, directory):
    try:
        path.resolve().relative_to(directory.resolve())
        return True
    except ValueError:
        return False


def private_source_path(path):
    path = Path(path).absolute()
    if within(path, ROOT):
        raise ValueError("Le cache brut doit être hors du dépôt et hors de public/.")
    if path.is_symlink() or path.parent.is_symlink():
        raise ValueError("Le cache brut ne doit pas être un lien symbolique.")
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.parent.stat().st_uid != os.getuid():
        raise ValueError("Le dossier de cache appartient à un autre utilisateur.")
    os.chmod(path.parent, 0o700)
    if path.exists() and (not stat.S_ISREG(path.stat().st_mode) or path.stat().st_uid != os.getuid()):
        raise ValueError("Le cache existant n’est pas un fichier privé régulier.")
    return path


def download_source(destination):
    destination = private_source_path(destination)
    deadline = time.monotonic() + 90
    descriptor, temporary = tempfile.mkstemp(prefix=".trees-", suffix=".json.tmp", dir=destination.parent)
    size = 0
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb") as output:
            request = Request(SOURCE_URL, headers={"Accept": "application/json", "User-Agent": "x-notif-tam-city-compiler/1"})
            with urlopen(request, timeout=30) as response:
                advertised = response.headers.get("Content-Length")
                if advertised and int(advertised) > MAX_SOURCE_BYTES:
                    raise ValueError("L’inventaire dépasse la taille maximale autorisée.")
                while True:
                    chunk = response.read(128 * 1024)
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > MAX_SOURCE_BYTES or time.monotonic() > deadline:
                        raise ValueError("Téléchargement interrompu : taille ou durée dépassée.")
                    output.write(chunk)
            output.flush()
            os.fsync(output.fileno())
        # Validate before replacing a previous valid source file.
        with open(temporary, encoding="utf-8-sig") as stream:
            data = json.load(stream)
        if data.get("type") != "FeatureCollection" or not isinstance(data.get("features"), list):
            raise ValueError("La source n’est pas un inventaire GeoJSON.")
        os.replace(temporary, destination)
        return size
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class Ring:
    """Ray casting with latitude buckets; no projected coordinates or buffer."""
    def __init__(self, coordinates):
        points = [(float(point[0]), float(point[1])) for point in coordinates]
        if len(points) < 3 or any(not math.isfinite(value) for point in points for value in point):
            raise ValueError("Anneau communal invalide.")
        if points[0] != points[-1]:
            points.append(points[0])
        self.bounds = (min(p[0] for p in points), min(p[1] for p in points), max(p[0] for p in points), max(p[1] for p in points))
        if self.bounds[1] == self.bounds[3]:
            raise ValueError("Anneau communal sans surface.")
        self.buckets = [[] for _ in range(256)]
        for first, last in zip(points, points[1:]):
            low, high = sorted((self.bucket(first[1]), self.bucket(last[1])))
            for bucket in range(low, high + 1):
                self.buckets[bucket].append((first, last))

    def bucket(self, latitude):
        return max(0, min(255, int((latitude - self.bounds[1]) / (self.bounds[3] - self.bounds[1]) * 256)))

    def location(self, longitude, latitude):
        # 0 outside, 1 inside, 2 exactly on an edge (floating-point tolerance).
        left, bottom, right, top = self.bounds
        if longitude < left or longitude > right or latitude < bottom or latitude > top:
            return 0
        inside = False
        for (ax, ay), (bx, by) in self.buckets[self.bucket(latitude)]:
            cross = (longitude - ax) * (by - ay) - (latitude - ay) * (bx - ax)
            if abs(cross) <= 1e-14 and min(ax, bx) <= longitude <= max(ax, bx) and min(ay, by) <= latitude <= max(ay, by):
                return 2
            if (ay > latitude) != (by > latitude) and longitude < ax + (latitude - ay) * (bx - ax) / (by - ay):
                inside = not inside
        return 1 if inside else 0


class Boundary:
    def __init__(self, geojson):
        self.polygons = []
        features = geojson.get("features", [geojson]) if geojson.get("type") == "FeatureCollection" else [geojson]
        for feature in features:
            geometry = feature.get("geometry", feature)
            if geometry.get("type") not in ("Polygon", "MultiPolygon"):
                raise ValueError("Le contour doit être Polygon ou MultiPolygon en WGS84.")
            polygons = [geometry["coordinates"]] if geometry["type"] == "Polygon" else geometry["coordinates"]
            self.polygons.extend([[Ring(ring) for ring in polygon] for polygon in polygons])
        if not self.polygons or any(not polygon for polygon in self.polygons):
            raise ValueError("Le contour communal est vide.")

    def covers(self, longitude, latitude):
        for polygon in self.polygons:
            outer = polygon[0].location(longitude, latitude)
            if not outer:
                continue
            holes = [ring.location(longitude, latitude) for ring in polygon[1:]]
            if outer == 2 or 2 in holes or not any(holes):
                return True
        return False


def compile_positions(data, boundary):
    if data.get("type") != "FeatureCollection" or not isinstance(data.get("features"), list):
        raise ValueError("La source doit être FeatureCollection.")
    positions = []
    counts = {"sourceFeatures": len(data["features"]), "invalid": 0, "outsideMunicipality": 0, "roundingOutside": 0}
    for feature in data["features"]:
        geometry = feature.get("geometry") or {}
        point = geometry.get("coordinates")
        if geometry.get("type") != "Point" or not isinstance(point, list) or len(point) < 2:
            counts["invalid"] += 1
            continue
        longitude, latitude = point[:2]
        if isinstance(longitude, bool) or isinstance(latitude, bool) or not isinstance(longitude, (int, float)) or not isinstance(latitude, (int, float)) or not math.isfinite(longitude) or not math.isfinite(latitude) or abs(longitude) > 180 or abs(latitude) > 90:
            counts["invalid"] += 1
            continue
        if not boundary.covers(longitude, latitude):
            counts["outsideMunicipality"] += 1
            continue
        rounded = [round(longitude, 7), round(latitude, 7)]
        if not boundary.covers(*rounded):
            counts["roundingOutside"] += 1
            continue
        positions.append(rounded)
    counts["publishedPositions"] = len(positions)
    counts["duplicatePositions"] = len(positions) - len({tuple(point) for point in positions})
    counts["squarePlanchonRequestedBbox"] = {"bbox": list(SQUARE_BBOX), "count": sum(SQUARE_BBOX[0] <= lon <= SQUARE_BBOX[2] and SQUARE_BBOX[1] <= lat <= SQUARE_BBOX[3] for lon, lat in positions)}
    counts["bounds"] = [min(p[0] for p in positions), min(p[1] for p in positions), max(p[0] for p in positions), max(p[1] for p in positions)] if positions else None
    return positions, counts


def write_public(destination, document):
    if destination.is_symlink():
        raise ValueError("La sortie ne doit pas être un lien symbolique.")
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".trees-", suffix=".json.tmp", dir=destination.parent)
    try:
        os.fchmod(descriptor, 0o644)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(document, stream, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, destination)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def vegetation_reference(filename, public_url="/city/trees.json"):
    """Build metadata for the city compiler's own staged manifest/publish step.

    This helper never reads or writes a manifest, avoiding concurrent overwrites.
    """
    raw = Path(filename).read_bytes()
    document = json.loads(raw)
    if set(document) != {"version", "source", "license", "date", "positions"} or document["version"] != 1 or document["license"] != "ODbL-1.0" or document["source"].get("url") != SOURCE_URL:
        raise ValueError("L’export de végétation est invalide.")
    if not document["positions"] or any(not isinstance(point, list) or len(point) != 2 or any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) for value in point) or abs(point[0]) > 180 or abs(point[1]) > 90 for point in document["positions"]):
        raise ValueError("L’export de végétation contient des positions invalides.")
    return {"url": public_url, "source": document["source"], "license": document["license"], "date": document["date"],
            "pointCount": len(document["positions"]), "sha256": hashlib.sha256(raw).hexdigest()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path(tempfile.gettempdir()) / "city-source" / "MMM_MTP_Arbres.json")
    parser.add_argument("--boundary", type=Path, default=ROOT / "public/city/boundary.geojson")
    parser.add_argument("--output", type=Path, default=ROOT / "public/city/trees.json")
    parser.add_argument("--date", default="2026-11-08")
    parser.add_argument("--download", action="store_true")
    arguments = parser.parse_args()
    source = private_source_path(arguments.source)
    if arguments.download:
        download_source(source)
    if source.stat().st_size > MAX_SOURCE_BYTES:
        raise ValueError("Inventaire brut trop volumineux.")
    os.chmod(source, 0o600)
    raw = source.read_bytes()
    data = json.loads(raw.decode("utf-8-sig"))
    boundary_bytes = arguments.boundary.read_bytes()
    boundary = Boundary(json.loads(boundary_bytes))
    positions, counts = compile_positions(data, boundary)
    if not positions:
        raise ValueError("Aucun arbre trouvé dans la commune ; sortie précédente conservée.")
    write_public(arguments.output, {"version": 1, "source": {"title": SOURCE_TITLE, "url": SOURCE_URL}, "license": "ODbL-1.0", "date": arguments.date, "positions": positions})
    print(json.dumps({**counts, "sourceSha256": hashlib.sha256(raw).hexdigest(), "boundarySha256": hashlib.sha256(boundary_bytes).hexdigest(), "outputBytes": arguments.output.stat().st_size,
                      "vegetation": vegetation_reference(arguments.output)}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise SystemExit("Compilation des arbres interrompue : " + str(error))
