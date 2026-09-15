import { withBasePath } from "@/lib/basePath";
import { getMapSources } from "@/features/map/map.api";
import { getMapboxAccessToken } from "@/features/map/config";
import type { MapBasemap, MapSceneLayer, MapTerrain } from "@/features/map/map.schema";

type Style = string | Record<string, any>;

type AttributionLink = {
  text: string;
  url: string;
};

type Basemap = MapBasemap & {
  _promise?: Promise<Style>;
};

export type SceneLayerConfig = MapSceneLayer;
export type TerrainConfig = MapTerrain;

type BasemapCatalogItem = Basemap | SceneLayerConfig | TerrainConfig;

interface StyleSource {
  url?: string;
  tiles?: string[];
  minzoom?: number;
  maxzoom?: number;
  attribution?: string;
}

interface RemoteStyle extends Record<string, any> {
  glyphs?: string;
  sources?: Record<string, StyleSource>;
  sprite?: string;
}

interface BasemapMap {
  setMaxZoom(maxZoom: number): void;
  setStyle(style: Style, options: { diff: boolean; validate: boolean }): void;
}

let catalogPromise: Promise<BasemapCatalogItem[]> | null = null;

function getCatalog() {
  catalogPromise ??= getMapSources()
    .then((response) => {
      if (!response.ok) throw new Error(`Failed to load basemaps: ${response.status}`);
      return response.json() as Promise<BasemapCatalogItem[]>;
    });
  return catalogPromise;
}

export function getBasemaps() {
  return getCatalog()
    .then((catalog) => {
      return catalog.filter((item): item is Basemap => item.kind === "basemap");
    });
}

export function getSceneLayers() {
  return getCatalog().then((catalog) => catalog.filter((item): item is SceneLayerConfig => item.kind === "sceneLayer"));
}

export function getTerrain() {
  return getCatalog().then((catalog) => catalog.find((item): item is TerrainConfig => item.kind === "terrain"));
}

function appendLabel(element: HTMLElement, basemap: Basemap) {
  if (basemap.costly) {
    element.classList.add("has-money-icon");
  }
  element.append(basemap.label);
}

// Resolve a relative URL against a base, preserving {template} placeholders
// which the URL constructor would percent-encode.
function resolveUrl(url: string, base: string) {
  if (!url || /^https?:\/\//.test(url)) return url;
  const tokens: string[] = [];
  // Use an alphanumeric placeholder — URL constructor won't percent-encode it,
  // unlike \x00 which becomes %00 and breaks the back-substitution regex.
  const escaped = url.replace(/\{[^}]+\}/g, (m) => { tokens.push(m); return `__T${tokens.length - 1}__`; });
  const resolved = new URL(escaped, base).href;
  return resolved.replace(/__T(\d+)__/g, (_, i) => tokens[Number(i)]);
}

function applyAttributionLinks(attribution: string | undefined, links: AttributionLink[]) {
  return links.reduce((value, link) => value?.replace(
    link.text,
    `<a href="${link.url}" target="_blank" rel="noopener noreferrer">${link.text}</a>`
  ), attribution);
}

// Fetch an ArcGIS style JSON and rewrite all relative URLs to absolute.
// ArcGIS styles use relative paths for sprite, glyphs, source TileJSON, and
// the tile URLs *inside* that TileJSON — so we fetch the TileJSON ourselves
// and inline the resolved tile URLs directly, preventing MapLibre from ever
// seeing a relative tile path.
async function loadRemoteStyle(styleUrl: string, attributionLinks: AttributionLink[] = []): Promise<RemoteStyle> {
  const res = await fetch(styleUrl);
  if (!res.ok) throw new Error(`Failed to load style: ${res.status} ${styleUrl}`);
  const style = await res.json() as RemoteStyle;

  if (style.sprite) style.sprite = resolveUrl(style.sprite, styleUrl);
  if (style.glyphs) style.glyphs = resolveUrl(style.glyphs, styleUrl);

  await Promise.all(Object.values(style.sources ?? {}).map(async (src) => {
    if (src.url) {
      const tileJsonUrl = resolveUrl(src.url, styleUrl);
      try {
        const tjRes = await fetch(tileJsonUrl);
        if (tjRes.ok) {
          const tj = await tjRes.json() as StyleSource;
          if (Array.isArray(tj.tiles) && tj.tiles.length > 0) {
            src.tiles = tj.tiles.map(t => resolveUrl(t, tileJsonUrl));
            if (tj.minzoom != null) src.minzoom ??= tj.minzoom;
            if (tj.maxzoom != null) src.maxzoom ??= tj.maxzoom;
            if (tj.attribution) src.attribution ??= tj.attribution;
            delete src.url;
            src.attribution = applyAttributionLinks(src.attribution, attributionLinks);
            console.info("[Map App] Resolved remote style source", {
              tileJsonUrl,
              tiles: src.tiles.slice(0, 2),
              minzoom: src.minzoom,
              maxzoom: src.maxzoom
            });
            return;
          }
        }
      } catch {}
      src.url = tileJsonUrl;
    }
    if (src.tiles) src.tiles = src.tiles.map(t => resolveUrl(t, styleUrl));
    src.attribution = applyAttributionLinks(src.attribution, attributionLinks);
    console.info("[Map App] Remote style source fallback", {
      tiles: src.tiles?.slice(0, 2),
      url: src.url
    });
  }));

  return style;
}

export async function getStyle(basemap: Basemap): Promise<Style> {
  if (basemap.style.type === "inline") return basemap.style.value!;
  if (basemap.style.type === "direct") {
    return basemap.style.url!.replace("{{mapboxAccessToken}}", getMapboxAccessToken());
  }
  basemap._promise ??= loadRemoteStyle(basemap.style.url!, basemap.style.attributionLinks);
  return basemap._promise;
}

export class BasemapControl {
  _basemaps: Basemap[];
  _container: HTMLDivElement | null;
  _currentId: string;
  _map: BasemapMap | null;

  constructor(basemaps: Basemap[]) {
    this._basemaps = basemaps;
    this._currentId = basemaps[0].id;
    this._map = null;
    this._container = null;
  }

  onAdd(map: BasemapMap) {
    this._map = map;
    this._container = document.createElement("div");
    this._container.className = "map-display-options";
    this._render();
    return this._container;
  }

  onRemove() {
    this._container!.remove();
    this._map = null;
  }

  _render() {
    this._container!.innerHTML = "";
    this._basemaps.forEach((basemap) => {
      const item = document.createElement("button");
      const missingToken = basemap.requiresMapboxAccessToken && !getMapboxAccessToken();
      item.className = "map-display-option map-display-radio" + (basemap.id === this._currentId ? " is-active" : "");
      item.type = "button";
      item.disabled = missingToken;
      item.title = missingToken ? "Mapbox access token required" : "";
      item.setAttribute("aria-pressed", String(basemap.id === this._currentId));
      appendLabel(item, basemap);
      item.addEventListener("click", () => this._select(basemap.id));
      this._container!.appendChild(item);
    });
  }

  async _select(id: string) {
    if (id === this._currentId) { this._render(); return; }
    const basemap = this._basemaps.find(b => b.id === id);
    this._currentId = id;
    this._render();
    const style = await getStyle(basemap!);
    this._map!.setMaxZoom(basemap!.maxZoom);
    // External basemap styles include properties MapLibre's strict validator
    // rejects, and projection changes require a full style replacement.
    this._map!.setStyle(style, { diff: false, validate: false });
  }
}
