#!/usr/bin/env python3
"""Compile official Montpellier CityGML into bounded, indexed MCT1 mesh tiles.

Authoring dependencies (isolated venv recommended):
  pyproj==3.8.0 lxml==6.1.3 mapbox-earcut==2.1.0 numpy==2.5.4 shapely==2.2.0
Sources and dependency API references are recorded in the generated manifest.
No imagery, credentials, database, or network request is used by this compiler.

MCT1 is little endian, header 80 bytes: magic[4], version:u16, flags:u16
(bit0 = uint32 indices), vertexCount:u32, indexCount:u32, origin:3*f64,
scaleNorm:f64, quantizationMeters:f64, positionsOffset:u32,
normalsOffset:u32, surfacesOffset:u32, indicesOffset:u32, byteLength:u32,
buildingCount:u32. Positions are 3*i16, normals 3*i8, surfaces u8 per vertex.
Normals use east/north/up; positions use Mercator east/south/up.
world = origin + position * scaleNorm. Index buffers are aligned to 4 bytes.
"""

import argparse
import collections
import gzip
import hashlib
import io
import json
import math
from pathlib import Path
import re
import shutil
import struct
import sys
import time
import zipfile

import lxml.etree as ET
import mapbox_earcut as earcut
import numpy as np
from pyproj import Transformer
from shapely import make_valid
from shapely.geometry import Polygon, box, mapping, shape
from shapely.ops import transform, unary_union

DATASET = "https://data.montpellier3m.fr/dataset/batiments-3d-de-la-ville-et-metropole-de-montpellier"
ARCHIVE = "https://data.montpellier3m.fr/sites/default/files/ressources/MMM_MMM_Bat3D.zip"
NOTE = "https://data.montpellier3m.fr/sites/default/files/ressources/MMM_MMM_Bat3D_Note.pdf"
BOUNDARY = "https://data.montpellier3m.fr/sites/default/files/ressources/VilleMTP_MTP_LimiteCommune.geojson"
GML = "{http://www.opengis.net/gml}"
BLDG = "{http://www.opengis.net/citygml/building/2.0}"
GEN = "{http://www.opengis.net/citygml/generics/2.0}"
CORE = "{http://www.opengis.net/citygml/2.0}"
TYPES = {"RoofSurface": 0, "WallSurface": 1, "GroundSurface": 2,
         "OuterCeilingSurface": 3, "OuterFloorSurface": 4}
CIRCUMFERENCE = 2 * math.pi * 6378137
TO_GPS = Transformer.from_crs(2154, 4326, always_xy=True)
FROM_GPS = Transformer.from_crs(4326, 2154, always_xy=True)
TO_MERCATOR = Transformer.from_crs(2154, 3857, always_xy=True)


def dumps(value):
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def polygon_rings(polygon):
    result = []
    for boundary in ("exterior", "interior"):
        for ring in polygon.findall(f"{GML}{boundary}/{GML}LinearRing"):
            pos = ring.find(f"{GML}posList")
            if pos is not None and pos.text:
                points = np.fromstring(pos.text, sep=" ", dtype=np.float64).reshape(-1, 3)
            else:
                points = np.array([[float(v) for v in p.text.split()] for p in ring.findall(f"{GML}pos")])
            if len(points) < 3:
                continue
            if np.allclose(points[0], points[-1], rtol=0, atol=1e-7):
                points = points[:-1]
            # Remove exact adjacent duplicates; preserve all original corners.
            keep = np.r_[True, np.any(np.abs(np.diff(points, axis=0)) > 1e-7, axis=1)]
            points = points[keep]
            if len(points) >= 3:
                result.append(points)
    return result


def footprint_of(surfaces):
    polygons = []
    for kind, rings in surfaces:
        if kind != 2:
            continue
        polygon = Polygon(rings[0][:, :2], [r[:, :2] for r in rings[1:]])
        if not polygon.is_valid:
            polygon = make_valid(polygon)
        if not polygon.is_empty and polygon.area > 0:
            polygons.append(polygon)
    return unary_union(polygons) if polygons else None


def newell(points):
    local = points - points[0]
    return np.sum(np.cross(local, np.roll(local, -1, axis=0)), axis=0)


class Tile:
    def __init__(self, owner, part, tile_size, quantum):
        self.id = f"{owner[0]}-{owner[1]}-{part}"
        self.x = (owner[0] + .5) * tile_size
        self.y = (owner[1] + .5) * tile_size
        lon, lat = TO_GPS.transform(self.x, self.y)
        mx, my = TO_MERCATOR.transform(self.x, self.y)
        self.origin = [(mx + CIRCUMFERENCE / 2) / CIRCUMFERENCE,
                       (.5 - my / CIRCUMFERENCE), 0.0]
        self.meter_scale = 1 / (CIRCUMFERENCE * math.cos(math.radians(lat)))
        self.scale = quantum * self.meter_scale
        self.quantum = quantum
        self.positions = []
        self.normals = []
        self.surfaces = []
        self.indices = []
        self.lookup = {}
        self.building_count = 0
        self.bounds = [math.inf, math.inf, -math.inf, -math.inf]

    def add_building(self, surfaces, base, stats):
        start = len(self.indices)
        for kind, rings in surfaces:
            if kind > 1:
                continue
            count = np.cumsum([len(ring) for ring in rings], dtype=np.uint32)
            source = np.concatenate(rings)
            normal = newell(rings[0])
            length = np.linalg.norm(normal)
            if length < 1e-8:
                stats["degeneratePolygonCount"] += 1
                continue
            # Orthographic dominant plane works for vertical walls and sloped roofs.
            drop_axis = int(np.argmax(np.abs(normal)))
            flat = np.delete(source - source[0], drop_axis, axis=1)
            triangles = earcut.triangulate_float64(flat, count).reshape(-1, 3)
            if not len(triangles):
                stats["untriangulatedPolygonCount"] += 1
                continue
            # Verify polygon area including holes against Earcut's projected area.
            def area(points):
                return abs(np.sum(points[:, 0] * np.roll(points[:, 1], -1)
                                  - points[:, 1] * np.roll(points[:, 0], -1))) / 2
            projected_rings = np.split(flat, count[:-1])
            expected = area(projected_rings[0]) - sum(area(r) for r in projected_rings[1:])
            q = flat[triangles]
            actual = np.abs((q[:, 1, 0] - q[:, 0, 0]) * (q[:, 2, 1] - q[:, 0, 1])
                            - (q[:, 1, 1] - q[:, 0, 1]) * (q[:, 2, 0] - q[:, 0, 0])).sum() / 2
            deviation = abs(actual - expected) / max(expected, 1e-8)
            stats["maxSourceTriangulationAreaDeviation"] = max(stats["maxSourceTriangulationAreaDeviation"], float(deviation))
            if deviation > .001:
                # A few source rings self-intersect or contain collapsed holes.
                # Repair in the actual face plane, then lift intersection points
                # back onto that plane; never fan-triangulate a concave outline.
                planar = Polygon(projected_rings[0], projected_rings[1:])
                fixed = make_valid(planar)
                components = [fixed] if fixed.geom_type == "Polygon" else list(getattr(fixed, "geoms", []))
                axes = [axis for axis in range(3) if axis != drop_axis]
                repaired = []
                for component in components:
                    if component.geom_type != "Polygon" or component.area < 1e-8:
                        continue
                    lifted = []
                    for ring in [component.exterior, *component.interiors]:
                        xy = np.asarray(ring.coords)[:-1]
                        xyz = np.tile(source[0], (len(xy), 1))
                        xyz[:, axes] += xy
                        xyz[:, drop_axis] -= (xy @ normal[axes]) / normal[drop_axis]
                        lifted.append(xyz)
                    repaired.append((kind, lifted))
                if not repaired:
                    stats["degeneratePolygonCount"] += 1
                    continue
                stats["repairedPolygonCount"] += 1
                self.add_building(repaired, base, stats)
                continue
            stats["maxTriangulationAreaDeviation"] = max(stats["maxTriangulationAreaDeviation"], float(deviation))
            mx, my = TO_MERCATOR.transform(source[:, 0], source[:, 1])
            world = np.column_stack(((mx + CIRCUMFERENCE / 2) / CIRCUMFERENCE,
                                     .5 - my / CIRCUMFERENCE,
                                     np.maximum(0, source[:, 2] - base) * self.meter_scale))
            quantized = np.rint((world - self.origin) / self.scale).astype(np.int64)
            if quantized.min() < -32768 or quantized.max() > 32767:
                raise ValueError(f"MCT1 coordinate overflow in tile {self.id}")
            # ENU positions share one uniform scale, so their face normals are exact.
            enu = (world - world[0]) / self.meter_scale
            enu[:, 1] *= -1
            face_normal = newell(enu[:len(rings[0])])
            if kind == 0 and face_normal[2] < 0:
                face_normal *= -1
            face_normal /= np.linalg.norm(face_normal)
            nbytes = tuple(np.rint(np.clip(face_normal, -1, 1) * 127).astype(int).tolist())
            # Quantization can collapse source slivers: remove them after rounding.
            qp = quantized.astype(np.float64)
            qp[:, 1] *= -1
            vertices = qp[triangles]
            cross = np.cross(vertices[:, 1] - vertices[:, 0], vertices[:, 2] - vertices[:, 0])
            cross_length = np.linalg.norm(cross, axis=1)
            original = source[triangles]
            original_cross = np.cross(original[:, 1] - original[:, 0], original[:, 2] - original[:, 0])
            original_area = np.linalg.norm(original_cross, axis=1)
            alignment = np.abs(cross @ (np.asarray(nbytes) / 127.0)) / np.maximum(cross_length, 1e-20)
            # A zero-height source wall sliver can acquire a false horizontal
            # triangle when XY rounds to 5cm. Require both source area and a
            # post-rounding normal consistent with the original face plane.
            keep = (cross_length > 1e-8) & (original_area > 1e-8) & (alignment > .5)
            stats["degenerateTriangleCount"] += int((~keep).sum())
            triangles = triangles[keep]
            cross = cross[keep]
            for i in range(len(triangles)):
                tri = triangles[i]
                if np.dot(cross[i], face_normal) < 0:
                    tri = tri[[0, 2, 1]]
                for point_index in tri:
                    position = tuple(int(v) for v in quantized[point_index])
                    key = position + nbytes + (kind,)
                    index = self.lookup.get(key)
                    if index is None:
                        index = len(self.positions)
                        self.lookup[key] = index
                        self.positions.append(position)
                        self.normals.append(nbytes)
                        self.surfaces.append(kind)
                    self.indices.append(index)
        return start, len(self.indices) - start

    def write(self, output):
        if not self.indices:
            return None
        positions = np.array(self.positions, dtype="<i2").tobytes()
        normals = np.array(self.normals, dtype="i1").tobytes()
        surfaces = bytes(self.surfaces)
        index32 = len(self.positions) > 65535
        indices = np.array(self.indices, dtype="<u4" if index32 else "<u2").tobytes()
        align4 = lambda value: (value + 3) & ~3
        offsets = [80, align4(80 + len(positions))]
        offsets.append(align4(offsets[1] + len(normals)))
        index_offset = (offsets[-1] + len(surfaces) + 3) & ~3
        length = index_offset + len(indices)
        header = struct.pack("<4sHHII3ddd6I", b"MCT1", 1, int(index32),
                             len(self.positions), len(self.indices), *self.origin,
                             self.scale, self.quantum, *offsets, index_offset,
                             length, self.building_count)
        padding = bytes(index_offset - offsets[-1] - len(surfaces))
        data = (header + positions + bytes(offsets[1] - 80 - len(positions))
                + normals + bytes(offsets[2] - offsets[1] - len(normals))
                + surfaces + padding + indices)
        path = output / "tiles" / f"{self.id}.bin"
        path.write_bytes(data)
        return {"id": self.id, "url": f"/city/tiles/{self.id}.bin", "origin": self.origin,
                "scaleNorm": self.scale, "boundsWgs84": self.bounds,
                "buildingCount": self.building_count, "triangleCount": len(self.indices) // 3,
                "vertexCount": len(self.positions), "indexCount": len(self.indices),
                "byteLength": length, "gpuBytes": len(positions) + len(normals) + len(surfaces) + len(indices),
                "gzipByteLength": len(gzip.compress(data, compresslevel=6, mtime=0)),
                "sha256": hashlib.sha256(data).hexdigest()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", required=True, type=Path)
    parser.add_argument("--boundary", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--audit", required=True, type=Path)
    parser.add_argument("--trees", type=Path, help="Optional official trees.json; copied and referenced in the manifest")
    parser.add_argument("--bbox", nargs=4, type=float, metavar=("WEST", "SOUTH", "EAST", "NORTH"))
    parser.add_argument("--tile-size", type=float, default=512)
    parser.add_argument("--quantization", type=float, default=.05)
    parser.add_argument("--max-tile-bytes", type=int, default=1048576)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "tiles").mkdir(exist_ok=True)
    args.audit.parent.mkdir(parents=True, exist_ok=True)
    boundary_document = json.loads(args.boundary.read_text())
    boundary_geometry = boundary_document["features"][0]["geometry"]
    boundary_gps = shape(boundary_geometry)
    boundary_l93 = transform(FROM_GPS.transform, boundary_gps)
    selection = boundary_l93
    if args.bbox:
        selection = selection.intersection(transform(FROM_GPS.transform, box(*args.bbox)))
    (args.output / "boundary.geojson").write_text(dumps(boundary_document))
    stats = collections.Counter()
    heights = []
    base_deltas = []
    tiles = []
    processed = []
    skipped_batches = []
    seen = set()
    parts = collections.Counter()
    started = time.time()
    audit_stream = gzip.open(args.audit, "wt", encoding="utf-8", compresslevel=6)
    manifest = {"version": 1, "format": "MCT1", "status": "sample" if args.bbox else "complete",
                "source": {"title": "Bâtiments 3D de la Ville et Métropole de Montpellier",
                           "url": DATASET, "archiveUrl": ARCHIVE, "noteUrl": NOTE, "format": "CityGML 2.0 LoD2.2",
                           "year": 2020, "crs": "EPSG:2154+EPSG:5720"},
                "year": 2020, "license": "ODbL-1.0", "licenseUrl": "https://opendatacommons.org/licenses/odbl/1-0/",
                "attribution": "© Montpellier Méditerranée Métropole · Avineon · 2020 · ODbL 1.0",
                "boundarySource": BOUNDARY, "boundaryUrl": "/city/boundary.geojson", "boundary": boundary_geometry,
                "sourceTotalBatchCount": 15, "processedBatches": processed, "batchEnvelopes": [],
                "quantizationMeters": args.quantization, "tileSizeMeters": args.tile_size,
                "heightMethod": "Each building is lowered by source ZMIN (minimum GroundSurface Z fallback); no terrain model is included.",
                "normalAxes": "east,north,up", "positionAxes": "mercator-east,mercator-south,up",
                "surfaceTypes": {"0": "RoofSurface", "1": "WallSurface"},
                "clipping": {"method": "building-footprint-intersects-commune", "communeCode": "34172",
                             "boundaryUrl": "/city/boundary.geojson", "borderBuildingsKeptWhole": True},
                "coverageBoundsWgs84": args.bbox or list(boundary_gps.bounds),
                "dependencies": {"pyproj": "3.8.0", "lxml": "6.1.3", "mapbox-earcut": "2.1.0", "numpy": "2.5.4", "shapely": "2.2.0"},
                "tiles": tiles}
    tree_path = args.trees or args.output / "trees.json"
    if tree_path.is_file():
        tree_bytes = tree_path.read_bytes()
        tree_data = json.loads(tree_bytes)
        if tree_path.resolve() != (args.output / "trees.json").resolve():
            shutil.copyfile(tree_path, args.output / "trees.json")
        manifest["vegetation"] = {"url": "/city/trees.json", "source": tree_data["source"],
            "license": tree_data["license"], "licenseUrl": "https://opendatacommons.org/licenses/odbl/1-0/", "date": tree_data["date"],
            "pointCount": len(tree_data["positions"]), "sha256": hashlib.sha256(tree_bytes).hexdigest()}
    with zipfile.ZipFile(args.archive) as master:
        batches = sorted([i for i in master.infolist() if re.fullmatch(r"Batch\d+_bati_2020.zip", i.filename)],
                         key=lambda i: int(re.search(r"\d+", i.filename)[0]))
        for member in batches:
            buffers = {}
            with zipfile.ZipFile(io.BytesIO(master.read(member))) as batch:
                gml_member = next(i for i in batch.infolist() if i.filename.endswith(".gml"))
                with batch.open(gml_member) as stream:
                    head = stream.read(5000).decode("utf-8")
                bounds = re.findall(r"<gml:(?:lowerCorner|upperCorner)>(.*?)</gml:", head)
                lower, upper = [[float(v) for v in row.split()] for row in bounds]
                envelope = box(lower[0], lower[1], upper[0], upper[1])
                intersects = selection.intersects(envelope)
                envelope_gps = transform(TO_GPS.transform, envelope)
                manifest["batchEnvelopes"].append({"name": member.filename,
                    "boundsLambert93": [lower[0], lower[1], upper[0], upper[1]],
                    "boundsWgs84": list(envelope_gps.bounds), "footprintWgs84": mapping(envelope_gps),
                    "processed": bool(intersects)})
                if not intersects:
                    skipped_batches.append(member.filename)
                    continue
                print(f"Compiling {member.filename}", flush=True)
                with batch.open(gml_member) as stream:
                    for _, element in ET.iterparse(stream, events=("end",), tag=CORE + "cityObjectMember", huge_tree=True):
                        building = element.find(BLDG + "Building")
                        if building is None:
                            element.clear()
                            continue
                        stats["sourceBuildingCount"] += 1
                        source_id = building.get(GML + "id")
                        if source_id in seen:
                            stats["duplicateBuildingCount"] += 1
                            element.clear()
                            continue
                        seen.add(source_id)
                        # Reject outside footprints before decoding roof/wall meshes.
                        surfaces = [(2, rings) for ground in building.iter(BLDG + "GroundSurface")
                                    for polygon in ground.iter(GML + "Polygon")
                                    if (rings := polygon_rings(polygon))]
                        footprint = footprint_of(surfaces)
                        if footprint is None or not selection.intersects(footprint):
                            stats["excludedBuildingCount"] += 1
                            element.clear()
                            while element.getprevious() is not None:
                                del element.getparent()[0]
                            continue
                        if not boundary_l93.covers(footprint):
                            stats["borderCrossingBuildings"] += 1
                        for kind, name in ((0, "RoofSurface"), (1, "WallSurface")):
                            for surface in building.iter(BLDG + name):
                                for polygon in surface.iter(GML + "Polygon"):
                                    rings = polygon_rings(polygon)
                                    if rings:
                                        surfaces.append((kind, rings))
                        base = building.findtext(f"{GEN}doubleAttribute[@name='ZMIN']/{GEN}value")
                        if base is None:
                            base = min(r[:, 2].min() for kind, rings in surfaces if kind == 2 for r in rings)
                            stats["baseFallbackCount"] += 1
                        base = float(base)
                        ground_min = min(r[:, 2].min() for kind, rings in surfaces if kind == 2 for r in rings)
                        base_deltas.append(float(base - ground_min))
                        if abs(base) < .001 and ground_min > 1:
                            stats["zeroBaseAboveGroundCount"] += 1
                        centre = footprint.centroid
                        owner = (math.floor(centre.x / args.tile_size), math.floor(centre.y / args.tile_size))
                        tile = buffers.get(owner)
                        if tile is not None and len(tile.positions) * 10 + len(tile.indices) * 2 > args.max_tile_bytes * .8:
                            metadata = tile.write(args.output)
                            if metadata:
                                tiles.append(metadata)
                            del buffers[owner]
                            tile = None
                        if tile is None:
                            tile = Tile(owner, parts[owner], args.tile_size, args.quantization)
                            parts[owner] += 1
                            buffers[owner] = tile
                        index_start, index_count = tile.add_building(surfaces, base, stats)
                        if index_count:
                            tile.building_count += 1
                            stats["buildingCount"] += 1
                            heights.append(float(max(r[:, 2].max() for kind, rings in surfaces if kind < 2 for r in rings) - base))
                            for kind, rings in surfaces:
                                if kind == 0:
                                    stats["roofPolygonCount"] += 1
                                elif kind == 1:
                                    stats["wallPolygonCount"] += 1
                                stats["interiorRingCount"] += len(rings) - 1
                            footprint_gps = transform(TO_GPS.transform, footprint)
                            # Bounds include overhanging roofs, not only the ground footprint.
                            all_xy = np.concatenate([r[:, :2] for _, rings in surfaces for r in rings])
                            lon, lat = TO_GPS.transform(all_xy[:, 0], all_xy[:, 1])
                            current = [float(min(lon)), float(min(lat)), float(max(lon)), float(max(lat))]
                            tile.bounds = [min(tile.bounds[0], current[0]), min(tile.bounds[1], current[1]),
                                           max(tile.bounds[2], current[2]), max(tile.bounds[3], current[3])]
                            audit_stream.write(dumps({"sourceId": source_id, "tileId": tile.id,
                                                      "indexStart": index_start, "indexCount": index_count,
                                                      "footprintWgs84": mapping(footprint_gps)}) + "\n")
                        element.clear()
                        while element.getprevious() is not None:
                            del element.getparent()[0]
            for tile in buffers.values():
                metadata = tile.write(args.output)
                if metadata:
                    tiles.append(metadata)
            processed.append(member.filename)
            print(f"  {stats['buildingCount']} buildings selected, {len(tiles)} tiles, {time.time()-started:.1f}s", flush=True)
    audit_stream.close()
    stats.update({"triangleCount": sum(t["triangleCount"] for t in tiles),
                  "vertexCount": sum(t["vertexCount"] for t in tiles),
                  "byteLength": sum(t["byteLength"] for t in tiles),
                  "gzipByteLength": sum(t["gzipByteLength"] for t in tiles)})
    manifest["stats"] = dict(stats)
    manifest["heightDiagnostics"] = {
        "relativeHeightPercentilesMeters": dict(zip(["min", "p25", "p50", "p75", "p90", "p95", "p99", "max"],
            np.percentile(heights, [0, 25, 50, 75, 90, 95, 99, 100]).tolist())) if heights else {},
        "sourceZminMinusGroundMinRangeMeters": [min(base_deltas), max(base_deltas)] if base_deltas else [],
        "zeroBaseAboveGroundCount": stats["zeroBaseAboveGroundCount"]}
    manifest["skippedBatches"] = skipped_batches
    manifest["boundsWgs84"] = [min(t["boundsWgs84"][0] for t in tiles), min(t["boundsWgs84"][1] for t in tiles),
                               max(t["boundsWgs84"][2] for t in tiles), max(t["boundsWgs84"][3] for t in tiles)] if tiles else None
    manifest["clipping"].update({"auditSha256": hashlib.sha256(args.audit.read_bytes()).hexdigest(),
                                  "auditRecordCount": stats["buildingCount"],
                                  "borderCrossingBuildings": stats["borderCrossingBuildings"]})
    manifest["elapsedSeconds"] = round(time.time() - started, 2)
    referenced_tiles = {tile["id"] + ".bin" for tile in tiles}
    for old_tile in (args.output / "tiles").glob("*.bin"):
        if old_tile.name not in referenced_tiles:
            old_tile.unlink()
    for name in ("manifest.json", "index.json"):
        (args.output / name).write_text(dumps(manifest))
    print(dumps({"status": manifest["status"], "stats": dict(stats), "tiles": len(tiles), "elapsedSeconds": manifest["elapsedSeconds"]}), flush=True)


if __name__ == "__main__":
    main()
