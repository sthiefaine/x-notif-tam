"""Reproject existing artwork into one pixel canvas and a static zoom pyramid.

This is an offline cartographic resampling step. It does not redraw artwork,
invent detail, generate images with AI, or claim a surveyed GPS registration.
Requires numpy and opencv-python-headless in a separate production environment.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import math
from pathlib import Path

import cv2
import numpy as np

cv2.setNumThreads(1)
TILE = 512


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def project(matrix, points):
    points = np.array(points, dtype=np.float64)
    homogeneous = np.c_[points, np.ones(len(points))] @ matrix.T
    if not np.isfinite(homogeneous).all() or np.any(homogeneous[:, 2] <= 0):
        raise ValueError("Invalid projection or a pole through the image")
    return homogeneous[:, :2] / homogeneous[:, 2:]


def read_layers(calibration, public):
    layers, audit = [], []
    for item in calibration["layers"]:
        source = public / item["src"].lstrip("/")
        if not source.resolve().is_relative_to(public.resolve()):
            raise ValueError("Artwork must remain inside public")
        if sha(source) != item["sha256"]:
            raise ValueError(f"Artwork changed: {item['id']}")
        image = cv2.imread(str(source), cv2.IMREAD_COLOR)
        if image is None:
            raise ValueError(f"Unreadable artwork: {item['id']}")
        height, width = image.shape[:2]
        matrix = np.array(item["matrix"], dtype=np.float64).reshape(3, 3)
        matrix /= matrix[2, 2]
        if abs(np.linalg.det(matrix)) < 1e-12:
            raise ValueError(f"Singular image placement: {item['id']}")
        quad = project(matrix, [[0, 0], [width, 0], [width, height], [0, height]])
        if not cv2.isContourConvex(quad.astype(np.float32)):
            raise ValueError(f"Folded image placement: {item['id']}")
        mask = None
        if item["role"] != "overview":
            # Keep measured source-map content; do not rely on AI reconstruction
            # of the map's toolbar, side rail, footer and controls.
            valid = np.zeros((720, 1280), dtype=np.uint8)
            valid[78:676, 76:1204] = 1
            valid[614:676, 88:178] = 0
            mask = np.minimum(cv2.distanceTransform(valid, cv2.DIST_L2, 5) / 38.0, 1.0)
            to_art = np.array(item["sourceToArt"], dtype=np.float64).reshape(3, 3)
            mask = cv2.warpPerspective(mask, to_art, (width, height), flags=cv2.INTER_LINEAR)
        layer = {"id": item["id"], "image": image, "matrix": matrix, "mask": mask,
                 "role": item["role"], "quad": quad,
                 "bbox": [*quad.min(axis=0), *quad.max(axis=0)]}
        layers.append(layer)
        audit.append({"id": item["id"], "src": item["src"], "sha256": item["sha256"],
                      "width": width, "height": height, "matrix": matrix.tolist(),
                      "method": item["method"], "quad": quad.tolist()})
    if not layers or layers[0]["role"] != "overview":
        raise ValueError("A complete overview must be the first layer")
    return layers, audit


def intersects(box, viewport):
    return box[0] < viewport[2] and box[2] > viewport[0] and box[1] < viewport[3] and box[3] > viewport[1]


def build(calibration_path, public, output, workers, typescript):
    calibration_bytes = calibration_path.read_bytes()
    calibration = json.loads(calibration_bytes)
    calibration_sha256 = hashlib.sha256(calibration_bytes).hexdigest()
    world_width, world_height = calibration["space"]["width"], calibration["space"]["height"]
    layers, audit = read_layers(calibration, public)
    if world_width <= 0 or world_height <= 0 or world_width * world_height > 4_000_000:
        raise ValueError("Unexpected global canvas")
    output.mkdir(parents=True, exist_ok=True)
    counts, tiles_by_level = {}, {}
    levels = [{"level": level, "width": math.ceil(world_width * 2 ** level),
               "height": math.ceil(world_height * 2 ** level), "scale": 2 ** level}
              for level in range(6)]
    # Full city through the native density of regional drawings. Higher levels
    # are sparse around the actual close views, with existing parents elsewhere.
    detail_quads = [layer["quad"] for layer in layers if layer["role"] == "detail"]
    if detail_quads:
        points = np.concatenate(detail_quads)
        minimum, maximum = points.min(axis=0), points.max(axis=0)
        bounds4 = [max(0, math.floor(minimum[0] * 16 / TILE) - 1),
                   max(0, math.floor(minimum[1] * 16 / TILE) - 1),
                   min(math.ceil(levels[4]["width"] / TILE), math.ceil(maximum[0] * 16 / TILE) + 1),
                   min(math.ceil(levels[4]["height"] / TILE), math.ceil(maximum[1] * 16 / TILE) + 1)]
        # Align the close-view rectangle to groups of level-3 parents.
        bounds4[0] = bounds4[0] // 2 * 2
        bounds4[1] = bounds4[1] // 2 * 2
        bounds4[2] = min(math.ceil(levels[4]["width"] / TILE), math.ceil(bounds4[2] / 2) * 2)
        bounds4[3] = min(math.ceil(levels[4]["height"] / TILE), math.ceil(bounds4[3] / 2) * 2)
    else:
        bounds4 = [0, 0, 0, 0]
    for level in levels:
        number = level["level"]
        columns, rows = math.ceil(level["width"] / TILE), math.ceil(level["height"] / TILE)
        if number <= 3:
            coordinates = [(x, y) for y in range(rows) for x in range(columns)]
        else:
            multiplier = 2 ** (number - 4)
            coordinates = [(x, y) for y in range(bounds4[1] * multiplier, min(rows, bounds4[3] * multiplier))
                           for x in range(bounds4[0] * multiplier, min(columns, bounds4[2] * multiplier))]
            level["tiles"] = [list(tile) for tile in coordinates]
        tiles_by_level[number] = set(coordinates)
        (output / str(number)).mkdir(exist_ok=True)

    def filename(number, x, y):
        return output / str(number) / f"{x}_{y}.webp"

    def render(task):
        number, x, y = task
        level = levels[number]
        scale = level["scale"]
        width = min(TILE, level["width"] - x * TILE)
        height = min(TILE, level["height"] - y * TILE)
        viewport = [x * TILE / scale, y * TILE / scale, (x * TILE + width) / scale, (y * TILE + height) / scale]
        camera = np.array([[scale, 0, -x * TILE], [0, scale, -y * TILE], [0, 0, 1]], dtype=np.float64)
        composite = None
        for layer in layers:
            if not intersects(layer["bbox"], viewport):
                continue
            placement = camera @ layer["matrix"]
            warped = cv2.warpPerspective(layer["image"], placement, (width, height), flags=cv2.INTER_LINEAR)
            if layer["mask"] is None:
                composite = warped.astype(np.float32)
            else:
                alpha = cv2.warpPerspective(layer["mask"], placement, (width, height), flags=cv2.INTER_LINEAR)
                alpha = np.clip(alpha, 0, 1)[..., None]
                composite = composite * (1 - alpha) + warped * alpha
        if composite is None:
            raise ValueError("A tile has no overview")
        image = np.clip(composite, 0, 255).astype(np.uint8)
        if not cv2.imwrite(str(filename(number, x, y)), image, [cv2.IMWRITE_WEBP_QUALITY, 90]):
            raise ValueError("Failed to encode tile")
        return number

    with ThreadPoolExecutor(max_workers=workers) as pool:
        # First the complete regional canvas, then close pixels in their true
        # positions. All drawing placement and alpha are independent of zoom.
        tasks = [(number, x, y) for number in [3, 5] for x, y in sorted(tiles_by_level[number])]
        for index, number in enumerate(pool.map(render, tasks), 1):
            counts[number] = counts.get(number, 0) + 1
            if index % 100 == 0:
                print(f"Rendered {index}/{len(tasks)} tiles", flush=True)

    def downsample_parent(number, x, y):
        level = levels[number]
        width = min(TILE, level["width"] - x * TILE)
        height = min(TILE, level["height"] - y * TILE)
        joined = np.zeros((height * 2, width * 2, 3), dtype=np.uint8)
        children = tiles_by_level[number + 1]
        for dy in range(2):
            for dx in range(2):
                cx, cy = x * 2 + dx, y * 2 + dy
                if cx * TILE >= levels[number + 1]["width"] or cy * TILE >= levels[number + 1]["height"]:
                    continue
                if (cx, cy) not in children:
                    return False
                child = cv2.imread(str(filename(number + 1, cx, cy)), cv2.IMREAD_COLOR)
                if child is None:
                    raise ValueError("Missing child in pyramid")
                h, w = child.shape[:2]
                joined[dy * TILE:dy * TILE + h, dx * TILE:dx * TILE + w] = child
        image = cv2.resize(joined, (width, height), interpolation=cv2.INTER_AREA)
        if not cv2.imwrite(str(filename(number, x, y)), image, [cv2.IMWRITE_WEBP_QUALITY, 90]):
            raise ValueError("Failed to encode parent tile")
        return True

    # Downsample close views into their parents, so street positions do not
    # change when a sharper level arrives. The remainder retains the same mosaic.
    for x, y in sorted(tiles_by_level[4]):
        if not downsample_parent(4, x, y):
            render((4, x, y))
    for x, y in sorted(tiles_by_level[3]):
        downsample_parent(3, x, y)
    for number in [2, 1, 0]:
        for x, y in sorted(tiles_by_level[number]):
            if not downsample_parent(number, x, y):
                raise ValueError("Incomplete full-city pyramid")

    tile_audit, total_bytes = [], 0
    for level in levels:
        for x, y in sorted(tiles_by_level[level["level"]]):
            path = filename(level["level"], x, y)
            image = cv2.imread(str(path))
            expected = (min(TILE, level["height"] - y * TILE), min(TILE, level["width"] - x * TILE))
            if image is None or image.shape[:2] != expected:
                raise ValueError(f"Invalid tile {path.name}")
            size = path.stat().st_size
            total_bytes += size
            tile_audit.append({"level": level["level"], "x": x, "y": y, "bytes": size, "sha256": sha(path)})
    manifest = {"version": 1, "space": calibration["space"], "initialCenter": calibration["initialCenter"],
                "initialScale": calibration.get("initialScale", 12), "maxScale": 32,
                "credit": {"label": "Illustration IA · Référence : Google Maps. Images ©2026 Google.",
                           "href": "https://www.google.com/maps/@43.5241919,3.876,12470a,35y,37.73t/data=!3m1!1e3"},
                "pyramid": {"tileSize": TILE, "format": "webp", "urlTemplate": "/lab/continuous/v1/{level}/{x}_{y}.webp", "levels": levels}}
    (output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, separators=(",", ":")))
    if typescript:
        typescript.parent.mkdir(parents=True, exist_ok=True)
        module = '// Generated offline from one registered pixel mosaic.\nimport type { ContinuousAtlasManifest } from "@/lib/transit/continuous-atlas-camera";\n\n'
        module += "const continuousAtlas = " + json.dumps(manifest, ensure_ascii=False, indent=2) + " satisfies ContinuousAtlasManifest;\n\nexport default continuousAtlas;\n"
        temporary = typescript.with_suffix(".ts.tmp")
        temporary.write_text(module)
        temporary.replace(typescript)
    report = {"version": 1, "method": "one registered pixel mosaic, same composition through all pyramid levels",
              "gpsRegistrationCertified": False, "sourceCalibrationSha256": calibration_sha256, "sources": audit,
              "levels": [{"level": level["level"], "tiles": len(tiles_by_level[level["level"]])} for level in levels],
              "tileCount": len(tile_audit), "bytes": total_bytes, "tiles": tile_audit}
    (output / "audit.json").write_text(json.dumps(report, ensure_ascii=False, separators=(",", ":")))
    print(json.dumps({"complete": True, "tiles": len(tile_audit), "bytes": total_bytes, "sources": len(layers)}), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--calibration", type=Path, required=True)
    parser.add_argument("--public", type=Path, default=Path("public"))
    parser.add_argument("--output", type=Path, default=Path("public/lab/continuous/v1"))
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--typescript", type=Path, default=Path("data/continuous-atlas.ts"))
    options = parser.parse_args()
    build(options.calibration, options.public, options.output, max(1, min(options.workers, 8)), options.typescript)
