"use client";

import { useEffect, useRef, useState } from "react";
import type { CustomLayerInterface, CustomRenderMethodInput, Map as LibreMap } from "maplibre-gl";
import {
  CITY_MESH_GPU_BUDGET, CITY_MESH_MIN_ZOOM, cityAssetUrl, cityLocalMatrix,
  decodeCityMesh, parseCityMeshManifest, readCityTileResponse, selectCityMeshTiles,
  type CityBounds, type CityMeshManifest, type CityMeshTile, type CityOrigin, type DecodedCityMesh,
} from "@/lib/transit/city-mesh";
import "maplibre-gl/dist/maplibre-gl.css";
import { addIllustratedCityTrees } from "@/lib/transit/city-trees";
import styles from "./transit-city-mesh.module.css";

export type TransitCityMeshProps = {
  manifestUrl?: string;
  roofTextureUrl?: string;
  wallTextureUrl?: string;
  className?: string;
  styleUrl?: string;
};

type MeshStatus = { phase: "loading" | "ready" | "error"; detail: boolean; loading: number; visible: number; failed: number; limited: boolean; year: number; sample: boolean };
type GpuTile = { descriptor: CityMeshTile; vao: WebGLVertexArrayObject; buffers: WebGLBuffer[]; origin: CityOrigin; scale: number; metersPerUnit: number; indices: number; indexType: number; vertices: number; bytes: number; lastUsed: number };
const INITIAL_VIEW = { center: [3.8794, 43.6081] as [number, number], zoom: 18.2, pitch: 55, bearing: 90 };
const INITIAL_STATUS: MeshStatus = { phase: "loading", detail: true, loading: 0, visible: 0, failed: 0, limited: false, year: 2020, sample: false };
const BASE_STYLE = "https://tiles.openfreemap.org/styles/positron";

const VERTEX_SHADER = `#version 300 es
precision highp float;
layout(location = 0) in vec3 a_position;
layout(location = 1) in vec3 a_normal;
layout(location = 2) in float a_surface;
uniform mat4 u_matrix;
uniform float u_meters_per_unit;
uniform vec2 u_texture_offset;
uniform bool u_shadow;
out vec3 v_normal;
out vec3 v_position;
flat out float v_surface;
void main() {
  vec3 position = a_position;
  if (u_shadow) {
    position.xy += vec2(0.58, -0.83) * position.z;
    position.z = 0.10 / u_meters_per_unit;
  }
  gl_Position = u_matrix * vec4(position, 1.0);
  v_normal = a_normal;
  v_position = a_position * u_meters_per_unit;
  v_position.xy += u_texture_offset;
  v_surface = a_surface;
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec3 v_normal;
in vec3 v_position;
flat in float v_surface;
uniform sampler2D u_roof;
uniform sampler2D u_wall;
uniform bool u_has_roof;
uniform bool u_has_wall;
uniform bool u_shadow;
out vec4 fragColor;
void main() {
  if (v_surface > 1.5) discard;
  vec3 normal = normalize(v_normal);
  bool roof = v_surface < 0.5;
  if (u_shadow) {
    if (!roof) discard;
    fragColor = vec4(vec3(0.31, 0.34, 0.23) * 0.14, 0.14);
    return;
  }
  bool flatRoof = roof && abs(normal.z) > 0.98;
  vec2 wallUV = vec2(abs(normal.x) > abs(normal.y) ? v_position.y : v_position.x, v_position.z) / vec2(12.0, 10.5);
  vec3 color = roof ? vec3(0.72, 0.43, 0.32) : vec3(0.94, 0.87, 0.72);
  if (roof && u_has_roof) color = texture(u_roof, v_position.xy / 6.0).rgb;
  if (!roof && u_has_wall) color = mix(color, texture(u_wall, wallUV).rgb, 0.86);
  if (flatRoof) color = mix(color, vec3(0.69, 0.68, 0.62), 0.88);
  float sunlight = max(0.0, dot(normal, normalize(vec3(-0.45, -0.65, 0.78))));
  float shade = 0.72 + 0.28 * sunlight;
  // A subtle contact darkening gives the interpreted façades a little depth.
  if (!roof) shade *= mix(0.87, 1.0, smoothstep(0.0, 3.5, v_position.z));
  fragColor = vec4(color * shade, 1.0);
}`;

function shader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const result = gl.createShader(type);
  if (!result) throw new Error("Le rendu 3D n’a pas pu démarrer.");
  gl.shaderSource(result, source);
  gl.compileShader(result);
  if (!gl.getShaderParameter(result, gl.COMPILE_STATUS)) { gl.deleteShader(result); throw new Error("Le rendu 3D n’est pas disponible."); }
  return result;
}

class CityMeshLayer implements CustomLayerInterface {
  id = "montpellier-city-mesh";
  type = "custom" as const;
  renderingMode = "3d" as const;
  private map: LibreMap | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private cache = new globalThis.Map<string, GpuTile>();
  private inFlight = new globalThis.Map<string, AbortController>();
  private failures = new Set<string>();
  private wanted: CityMeshTile[] = [];
  private selected = new Set<string>();
  private usedBytes = 0;
  private sequence = 0;
  private disposed = false;
  private contextLost = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private matrix = new Float32Array(16);
  private textures: WebGLTexture[] = [];
  private hasTexture = [false, false];
  private images: HTMLImageElement[] = [];
  private detailed = true;
  private limited = false;
  private sample: boolean;

  constructor(private manifest: CityMeshManifest, private manifestUrl: string, private textureUrls: [string | undefined, string | undefined], private onStatus: (status: MeshStatus) => void) {
    this.sample = (manifest as CityMeshManifest & { status?: string }).status === "sample";
  }

  onAdd(map: LibreMap, gl: WebGL2RenderingContext) {
    this.map = map;
    this.gl = gl;
    this.setupProgram();
    map.on("move", this.onMove);
    map.on("moveend", this.refresh);
    map.on("webglcontextlost", this.onContextLost);
    map.on("webglcontextrestored", this.onContextRestored);
    this.refresh();
  }

  private setupProgram() {
    const gl = this.gl!;
    const previousActiveTexture = gl.getParameter(gl.ACTIVE_TEXTURE) as number;
    const vertex = shader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    const fragment = shader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    const program = gl.createProgram();
    if (!program) { gl.deleteShader(vertex); gl.deleteShader(fragment); throw new Error("Le rendu 3D n’a pas pu démarrer."); }
    gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program);
    gl.deleteShader(vertex); gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { gl.deleteProgram(program); throw new Error("Le rendu 3D n’est pas disponible."); }
    this.program = program;
    for (const key of ["matrix", "meters_per_unit", "texture_offset", "roof", "wall", "has_roof", "has_wall", "shadow"]) this.uniforms[key] = gl.getUniformLocation(program, `u_${key}`);
    this.hasTexture = [false, false];
    for (let slot = 0; slot < 2; slot++) {
      const texture = gl.createTexture();
      if (!texture) throw new Error("Le rendu des matières n’est pas disponible.");
      this.textures[slot] = texture;
      gl.activeTexture(gl.TEXTURE0 + slot);
      const previousTexture = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
      gl.bindTexture(gl.TEXTURE_2D, previousTexture);
      const url = this.textureUrls[slot];
      if (url) this.loadTexture(url, slot);
    }
    gl.activeTexture(previousActiveTexture);
  }

  private loadTexture(url: string, slot: number) {
    const image = new window.Image();
    image.crossOrigin = "anonymous";
    image.onload = () => {
      if (this.disposed || this.contextLost || !this.gl || !this.textures[slot]) return;
      const gl = this.gl;
      // Keep AI material images bounded even when their source resolution is large.
      const canvas = document.createElement("canvas");
      const ratio = Math.min(1, 512 / Math.max(image.naturalWidth, image.naturalHeight));
      canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
      const context = canvas.getContext("2d");
      if (!context) return;
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const previousActiveTexture = gl.getParameter(gl.ACTIVE_TEXTURE) as number;
      gl.activeTexture(gl.TEXTURE0 + slot);
      const previousTexture = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
      gl.bindTexture(gl.TEXTURE_2D, this.textures[slot]);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.bindTexture(gl.TEXTURE_2D, previousTexture); gl.activeTexture(previousActiveTexture);
      this.hasTexture[slot] = true;
      this.map?.triggerRepaint();
    };
    image.onerror = () => { /* The untextured palette remains usable. */ };
    image.src = url;
    this.images.push(image);
  }

  private onMove = () => {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.refresh(); }, 120);
  };

  private refresh = () => {
    if (this.disposed || this.contextLost || !this.map) return;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    const bounds = this.map.getBounds();
    const center = this.map.getCenter();
    const viewport: CityBounds = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
    this.detailed = this.map.getZoom() >= CITY_MESH_MIN_ZOOM;
    const selection = this.detailed ? selectCityMeshTiles(this.manifest.tiles, viewport, [center.lng, center.lat]) : { tiles: [], limited: false };
    this.wanted = selection.tiles;
    this.limited = selection.limited;
    this.selected = new Set(this.wanted.map((tile) => tile.id));
    for (const [id, controller] of this.inFlight) if (!this.selected.has(id)) { controller.abort(); this.inFlight.delete(id); }
    for (const id of this.selected) { const cached = this.cache.get(id); if (cached) cached.lastUsed = ++this.sequence; }
    this.pump();
    this.map.triggerRepaint();
  };

  private publish() {
    if (this.disposed) return;
    this.onStatus({ phase: "ready", detail: this.detailed, loading: this.inFlight.size, visible: this.wanted.filter((tile) => this.cache.has(tile.id)).length, failed: this.wanted.filter((tile) => this.failures.has(tile.id)).length, limited: this.limited, year: this.manifest.year, sample: this.sample });
  }

  private pump() {
    if (this.disposed || this.contextLost) return;
    for (const tile of this.wanted) {
      if (this.inFlight.size >= 2) break;
      if (this.cache.has(tile.id) || this.inFlight.has(tile.id) || this.failures.has(tile.id)) continue;
      const controller = new AbortController();
      this.inFlight.set(tile.id, controller);
      void this.fetchTile(tile, controller);
    }
    this.publish();
  }

  private async fetchTile(tile: CityMeshTile, controller: AbortController) {
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 20_000);
    try {
      const url = new URL(cityAssetUrl(tile.url, this.manifestUrl));
      // Sample and complete builds can reuse tile IDs; bind HTTP caching to content.
      if (tile.sha256) url.searchParams.set("v", tile.sha256);
      const response = await fetch(url, { signal: controller.signal, cache: tile.sha256 ? "force-cache" : "no-cache" });
      const buffer = await readCityTileResponse(response);
      if (controller.signal.aborted || this.disposed || this.contextLost || !this.selected.has(tile.id)) return;
      const mesh = decodeCityMesh(buffer);
      if (!this.makeRoom(mesh.gpuBytes)) { this.limited = true; this.failures.add(tile.id); return; }
      const gpu = this.upload(tile, mesh);
      this.cache.set(tile.id, gpu);
      this.usedBytes += gpu.bytes;
      this.map?.triggerRepaint();
    } catch {
      if ((!controller.signal.aborted || timedOut) && !this.disposed) this.failures.add(tile.id);
    } finally {
      clearTimeout(timeout);
      if (this.inFlight.get(tile.id) === controller) this.inFlight.delete(tile.id);
      this.pump();
    }
  }

  private makeRoom(bytes: number): boolean {
    if (bytes > CITY_MESH_GPU_BUDGET) return false;
    const removable = [...this.cache.values()].filter((tile) => !this.selected.has(tile.descriptor.id)).sort((a, b) => a.lastUsed - b.lastUsed);
    for (const tile of removable) {
      if (this.usedBytes + bytes <= CITY_MESH_GPU_BUDGET) break;
      this.release(tile); this.cache.delete(tile.descriptor.id); this.usedBytes -= tile.bytes;
    }
    return this.usedBytes + bytes <= CITY_MESH_GPU_BUDGET;
  }

  private upload(descriptor: CityMeshTile, mesh: DecodedCityMesh): GpuTile {
    const gl = this.gl!;
    const previousVao = gl.getParameter(gl.VERTEX_ARRAY_BINDING) as WebGLVertexArrayObject | null;
    const previousBuffer = gl.getParameter(gl.ARRAY_BUFFER_BINDING) as WebGLBuffer | null;
    const vao = gl.createVertexArray();
    if (!vao) throw new Error("Mémoire 3D indisponible.");
    const buffers: WebGLBuffer[] = [];
    gl.bindVertexArray(vao);
    try {
      for (const [location, values, size, type, normalize] of [
        [0, mesh.positions, 3, mesh.positions instanceof Int16Array ? gl.SHORT : gl.FLOAT, false],
        [1, mesh.normals, 3, mesh.normals instanceof Int8Array ? gl.BYTE : gl.FLOAT, mesh.normals instanceof Int8Array],
        [2, mesh.surfaces, 1, gl.UNSIGNED_BYTE, false],
      ] as const) {
        const buffer = gl.createBuffer();
        if (!buffer) throw new Error("Mémoire 3D indisponible.");
        buffers.push(buffer); gl.bindBuffer(gl.ARRAY_BUFFER, buffer); gl.bufferData(gl.ARRAY_BUFFER, values, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(location); gl.vertexAttribPointer(location, size, type, normalize, 0, 0);
      }
      if (mesh.indices) {
        const buffer = gl.createBuffer();
        if (!buffer) throw new Error("Mémoire 3D indisponible.");
        buffers.push(buffer); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buffer); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
      }
    } catch (error) { for (const buffer of buffers) gl.deleteBuffer(buffer); gl.deleteVertexArray(vao); throw error; }
    finally { gl.bindVertexArray(previousVao); gl.bindBuffer(gl.ARRAY_BUFFER, previousBuffer); }
    return { descriptor, vao, buffers, origin: mesh.origin, scale: mesh.scale, metersPerUnit: mesh.metersPerUnit, indices: mesh.indices?.length ?? 0, indexType: mesh.indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT, vertices: mesh.vertexCount, bytes: mesh.gpuBytes, lastUsed: ++this.sequence };
  }

  render(gl: WebGL2RenderingContext, options: CustomRenderMethodInput) {
    if (!this.program || this.contextLost || !this.detailed) return;
    gl.useProgram(this.program);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(true);
    gl.disable(gl.CULL_FACE); gl.disable(gl.STENCIL_TEST); gl.disable(gl.BLEND);
    for (let slot = 0; slot < 2; slot++) { gl.activeTexture(gl.TEXTURE0 + slot); gl.bindTexture(gl.TEXTURE_2D, this.textures[slot]); }
    gl.uniform1i(this.uniforms.roof, 0); gl.uniform1i(this.uniforms.wall, 1);
    gl.uniform1i(this.uniforms.has_roof, Number(this.hasTexture[0])); gl.uniform1i(this.uniforms.has_wall, Number(this.hasTexture[1]));
    for (const shadow of [true, false]) {
      gl.uniform1i(this.uniforms.shadow, Number(shadow));
      gl.depthMask(!shadow);
      if (shadow) { gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); }
      else gl.disable(gl.BLEND);
      for (const tile of this.cache.values()) {
        if (!this.selected.has(tile.descriptor.id)) continue;
        cityLocalMatrix(options.defaultProjectionData.mainMatrix, tile.origin, tile.scale, this.matrix);
        gl.uniformMatrix4fv(this.uniforms.matrix, false, this.matrix);
        gl.uniform1f(this.uniforms.meters_per_unit, tile.metersPerUnit);
        const unitsPerMeter = tile.scale / tile.metersPerUnit;
        gl.uniform2f(this.uniforms.texture_offset, (tile.origin[0] / unitsPerMeter) % 48, (tile.origin[1] / unitsPerMeter) % 48);
        gl.bindVertexArray(tile.vao);
        if (tile.indices) gl.drawElements(gl.TRIANGLES, tile.indices, tile.indexType, 0);
        else gl.drawArrays(gl.TRIANGLES, 0, tile.vertices);
      }
    }
    gl.bindVertexArray(null);
    gl.bindTexture(gl.TEXTURE_2D, null); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, null);
    gl.depthMask(false);
  }

  retry() { this.failures.clear(); this.refresh(); }
  getBounds(): CityBounds { return this.manifest.boundsWgs84; }

  private release(tile: GpuTile) { if (!this.gl || this.contextLost) return; for (const buffer of tile.buffers) this.gl.deleteBuffer(buffer); this.gl.deleteVertexArray(tile.vao); }
  private onContextLost = () => {
    this.contextLost = true;
    for (const controller of this.inFlight.values()) controller.abort();
    this.inFlight.clear(); this.cache.clear(); this.usedBytes = 0; this.program = null; this.textures = [];
    for (const image of this.images) { image.onload = null; image.onerror = null; image.src = ""; }
    this.images = [];
    this.onStatus({ ...INITIAL_STATUS, phase: "error", year: this.manifest.year, sample: this.sample });
  };
  private onContextRestored = () => {
    if (this.disposed) return;
    this.contextLost = false;
    try { this.setupProgram(); this.failures.clear(); this.refresh(); }
    catch { this.onStatus({ ...INITIAL_STATUS, phase: "error", year: this.manifest.year, sample: this.sample }); }
  };

  onRemove() {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.map?.off("move", this.onMove); this.map?.off("moveend", this.refresh);
    this.map?.off("webglcontextlost", this.onContextLost); this.map?.off("webglcontextrestored", this.onContextRestored);
    for (const controller of this.inFlight.values()) controller.abort();
    for (const tile of this.cache.values()) this.release(tile);
    for (const texture of this.textures) this.gl?.deleteTexture(texture);
    if (this.program) this.gl?.deleteProgram(this.program);
    for (const image of this.images) { image.onload = null; image.onerror = null; image.src = ""; }
    this.inFlight.clear(); this.cache.clear(); this.map = null; this.gl = null;
  }
}

/** Keep the vector plan quiet beneath the actual municipal roof geometry. */
function styleCityPlan(map: LibreMap) {
  for (const layer of map.getStyle().layers ?? []) {
    const id = layer.id.toLowerCase();
    if (layer.type === "fill-extrusion") { map.setLayoutProperty(layer.id, "visibility", "none"); continue; }
    if (layer.type === "background") map.setPaintProperty(layer.id, "background-color", "#f1eddf");
    if (layer.type === "fill") {
      if (/water/.test(id)) map.setPaintProperty(layer.id, "fill-color", "#b8d8d4");
      else if (/park|wood|forest|grass|landcover|landuse/.test(id)) map.setPaintProperty(layer.id, "fill-color", "#dce4cb");
      else if (/building/.test(id)) { map.setPaintProperty(layer.id, "fill-color", "#dfd8c6"); map.setPaintProperty(layer.id, "fill-opacity", 0.65); }
    }
    if (layer.type === "line" && /road|street|transport/.test(id) && !/rail|tram/.test(id)) map.setPaintProperty(layer.id, "line-color", /casing/.test(id) ? "#ded7c7" : "#fffdf1");
    if (layer.type === "symbol") map.setLayoutProperty(layer.id, "visibility", "none");
  }
}

export default function TransitCityMesh({ manifestUrl = "/city/manifest.json", roofTextureUrl, wallTextureUrl, className, styleUrl = BASE_STYLE }: TransitCityMeshProps) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LibreMap | null>(null);
  const layerRef = useRef<CityMeshLayer | null>(null);
  const [status, setStatus] = useState<MeshStatus>(INITIAL_STATUS);
  const [pitch, setPitch] = useState(INITIAL_VIEW.pitch);
  const [restart, setRestart] = useState(0);

  useEffect(() => {
    let disposed = false;
    let map: LibreMap | undefined;
    let observer: ResizeObserver | undefined;
    let removeTrees: (() => void) | undefined;
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
      if (!disposed) setStatus((previous) => ({ ...previous, phase: "error" }));
    }, 20_000);
    setStatus(INITIAL_STATUS);
    setPitch(INITIAL_VIEW.pitch);
    const initialize = async () => {
      try {
        const fullManifestUrl = cityAssetUrl(manifestUrl, window.location.href);
        const [maplibre, response] = await Promise.all([import("maplibre-gl"), fetch(fullManifestUrl, { signal: controller.signal, cache: "no-cache" })]);
        if (!response.ok) throw new Error("Les bâtiments ne sont pas encore disponibles.");
        const manifest = parseCityMeshManifest(await response.json());
        if (disposed || !container.current) return;
        maplibre.setWorkerUrl("/vendor/maplibre/maplibre-gl-worker.mjs");
        map = new maplibre.Map({
          container: container.current, style: styleUrl, ...INITIAL_VIEW,
          minZoom: 10.5, maxZoom: 20, maxPitch: 68, attributionControl: false,
          maxBounds: [[3.72, 43.50], [4.02, 43.73]], renderWorldCopies: false,
          pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
          canvasContextAttributes: { antialias: true },
          locale: { "AttributionControl.ToggleAttribution": "Crédits du plan" },
        });
        mapRef.current = map;
        map.on("pitchend", () => { if (!disposed && map) setPitch(Math.round(map.getPitch())); });
        map.getCanvas().setAttribute("aria-label", "Carte 3D de Montpellier. Flèches pour déplacer, plus et moins pour zoomer, Maj et flèches pour orienter.");
        map.addControl(new maplibre.AttributionControl({ compact: true, customAttribution: '<a href="https://data.montpellier3m.fr/dataset/batiments-3d-de-la-ville-et-metropole-de-montpellier" target="_blank" rel="noopener noreferrer">Bâtiments © Montpellier Méditerranée Métropole · Avineon · 2020 · ODbL</a>' }), "bottom-right");
        map.addControl(new maplibre.ScaleControl({ maxWidth: 100, unit: "metric" }), "bottom-left");
        const layer = new CityMeshLayer(manifest, fullManifestUrl, [roofTextureUrl, wallTextureUrl], (next) => { if (!disposed) setStatus((previous) => JSON.stringify(previous) === JSON.stringify(next) ? previous : next); });
        layerRef.current = layer;
        map.once("load", () => {
          clearTimeout(timeout);
          if (disposed || !map) return;
          try {
            styleCityPlan(map);
            const label = map.getStyle().layers?.find((item) => item.type === "symbol")?.id;
            map.addLayer(layer, label);
            removeTrees = addIllustratedCityTrees(map);
            const credits = map.getContainer().querySelector(".maplibregl-ctrl-attrib");
            credits?.classList.remove("maplibregl-compact-show"); credits?.removeAttribute("open");
          } catch { setStatus((previous) => ({ ...previous, phase: "error" })); }
        });
        map.on("error", () => { if (!disposed && !map?.isStyleLoaded()) setStatus((previous) => ({ ...previous, phase: "error" })); });
        if (typeof ResizeObserver !== "undefined") { observer = new ResizeObserver(() => map?.resize()); observer.observe(container.current); }
      } catch { if (!disposed && (!controller.signal.aborted || timedOut)) setStatus((previous) => ({ ...previous, phase: "error" })); }
    };
    void initialize();
    return () => { disposed = true; clearTimeout(timeout); controller.abort(); observer?.disconnect(); removeTrees?.(); map?.remove(); mapRef.current = null; layerRef.current = null; };
  }, [manifestUrl, roofTextureUrl, wallTextureUrl, styleUrl, restart]);

  const recenter = () => mapRef.current?.easeTo({ ...INITIAL_VIEW, duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 650 });
  const overview = () => {
    const bounds = layerRef.current?.getBounds();
    if (bounds) mapRef.current?.fitBounds([[bounds[0], bounds[1]], [bounds[2], bounds[3]]], { padding: 50, pitch: 0, bearing: 0, duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 700 });
  };

  return <section className={`${styles.viewport}${className ? ` ${className}` : ""}`} aria-label="Montpellier en trois dimensions" data-mesh-state={status.phase} data-mesh-tile-count={status.visible}>
    <div ref={container} className={styles.map} />
    <div className={styles.controls} aria-label="Commandes de la carte">
      <button type="button" aria-label="Zoomer" title="Zoomer" onClick={() => mapRef.current?.zoomIn({ duration: 250 })}>+</button>
      <button type="button" aria-label="Dézoomer" title="Dézoomer" onClick={() => mapRef.current?.zoomOut({ duration: 250 })}>−</button>
      <span className={styles.separator} />
      <button type="button" className={styles.recenter} aria-label="Recentrer sur la place de la Comédie" title="Recentrer" onClick={recenter}>⌖</button>
      <button type="button" className={styles.overview} aria-label={status.sample ? "Voir toute la zone disponible" : "Voir toute la ville"} title={status.sample ? "Toute la zone disponible" : "Toute la ville"} onClick={overview}>↗</button>
    </div>
    <div className={styles.orientation} aria-label="Orientation et perspective">
      <button type="button" aria-label="Tourner la carte à gauche" title="Tourner à gauche" onClick={() => { const map = mapRef.current; if (map) map.easeTo({ bearing: map.getBearing() - 30, duration: 300 }); }}>↶</button>
      <button type="button" aria-label="Tourner la carte à droite" title="Tourner à droite" onClick={() => { const map = mapRef.current; if (map) map.easeTo({ bearing: map.getBearing() + 30, duration: 300 }); }}>↷</button>
      <span className={styles.orientationSeparator} />
      <button type="button" className={styles.angle} aria-pressed={pitch === 45} aria-label="Incliner la vue à 45 degrés" title="Vue à 45°" onClick={() => mapRef.current?.easeTo({ pitch: 45, duration: 350 })}>45°</button>
      <button type="button" className={styles.angle} aria-pressed={pitch === 60} aria-label="Incliner la vue à 60 degrés" title="Vue à 60°" onClick={() => mapRef.current?.easeTo({ pitch: 60, duration: 350 })}>60°</button>
    </div>
    <div className={styles.caption}><span className={styles.dot} /><span>Bâtiments {status.year} · habillage IA · arbres symbolisés{status.sample ? " · centre, aperçu" : ""}</span></div>
    <div className={styles.hint}>Glisser pour explorer · clic droit pour orienter</div>
    <div className={styles.status} role="status" aria-live="polite">
      {status.phase === "loading" ? <span className={styles.pill}>Préparation de la carte…</span> : null}
      {status.phase === "error" ? <div className={styles.error}><span>La carte 3D est momentanément indisponible.</span><button type="button" onClick={() => setRestart((value) => value + 1)}>Réessayer</button></div> : null}
      {status.phase === "ready" && !status.detail ? <button type="button" className={styles.pillButton} onClick={recenter}>Rapprochez-vous pour découvrir les toitures ↗</button> : null}
      {status.phase === "ready" && status.detail && status.loading ? <span className={styles.pill}>Détail des bâtiments…</span> : null}
      {status.phase === "ready" && status.detail && !status.loading && status.limited ? <span className={styles.pill}>Rapprochez la vue pour voir tous les bâtiments.</span> : null}
      {status.phase === "ready" && status.detail && !status.loading && status.failed ? <button type="button" className={styles.pillButton} onClick={() => layerRef.current?.retry()}>Certains bâtiments sont indisponibles · Réessayer</button> : null}
      {status.phase === "ready" && status.detail && !status.loading && !status.failed && !status.visible ? <span className={styles.pill}>{status.sample ? "Les bâtiments de cet aperçu couvrent le centre." : "Aucun bâtiment disponible dans cette zone."}</span> : null}
    </div>
  </section>;
}
