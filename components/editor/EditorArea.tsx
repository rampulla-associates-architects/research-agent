"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import * as maplibregl from "maplibre-gl";
import { Map, Marker, NavigationControl, Source, useControl, type MapRef } from "@vis.gl/react-maplibre";
import { Tile3DLayer } from "@deck.gl/geo-layers";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { COORDINATE_SYSTEM, I3SLoader } from "@loaders.gl/i3s";
import { EditorNavbar, type EditorNavTab } from "@/components/editor/EditorNavbar";
import { EditorPanel } from "@/components/editor/EditorPanel";
import { EditorPanelItem } from "@/components/editor/EditorPanelItem";
import { EditorPdfPanel } from "@/components/editor/EditorPdfPanel";
import { EditorHtmlElementView } from "@/components/editor/EditorHtmlElementView";
import { FileViewer } from "@/features/folder/components/FileViewer";
import { RecordGraphView } from "@/features/record/components/RecordGraphView";
import { getBasemaps, getSceneLayers, getStyle, getTerrain, type SceneLayerConfig, type TerrainConfig } from "@/features/map/components/providers/basemaps";
import { getMapboxAccessToken, STATEN_ISLAND_BOUNDS } from "@/features/map/config";
import { withBasePath } from "@/lib/basePath";
import { loadWorkspaceEditorState, saveWorkspaceEditorState } from "@/lib/workspaceEditors";
import type { WorkspaceInvalidationState } from "@/lib/workspaceInvalidation";

type EditorTabKind = "map" | "json" | "file" | "pdf" | "table" | "graph";

type JsonTabOptions = Record<string, any> & {
  initialMode?: "raw" | "rich";
};

type EditorTab = EditorNavTab & {
  dirty?: boolean;
  element?: ReactNode;
  entry?: any;
  kind: EditorTabKind;
  options?: JsonTabOptions;
  value?: unknown;
};

type EditorDraft = {
  mode: "raw" | "list" | "table" | "graph";
  rawText: string;
  value: unknown;
};

type EditorDraftStore = Record<string, EditorDraft>;

type AddressMapSelection = {
  coordinates: [number, number];
  item: unknown;
  label: string;
};

type BasemapItem = Awaited<ReturnType<typeof getBasemaps>>[number];

type EditorAreaProps = {
  openAddressOnMapRef?: RefObject<((address: unknown) => void) | null>;
  openFileRef?: RefObject<((entry: unknown) => void) | null>;
  openPageRef?: RefObject<((id: string, label: string, value: unknown, options?: unknown) => void) | null>;
  suggestToolRef?: RefObject<((name: string) => void) | null>;
  workspaceInvalidation?: WorkspaceInvalidationState;
};

const EDITOR_DRAFTS_KEY = "editor-drafts";

const DEFAULT_MAP_TAB: EditorTab = {
  closeable: false,
  id: "map",
  kind: "map",
  label: "Map"
};

const DEFAULT_VIEW_STATE = {
  bounds: STATEN_ISLAND_BOUNDS as any,
  fitBoundsOptions: { padding: 36 } as any
} as any;

const getStoredDrafts = (): EditorDraftStore => {
  if (typeof localStorage === "undefined") return {};
  try {
    const data = JSON.parse(localStorage.getItem(EDITOR_DRAFTS_KEY) || "{}");
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
};

const saveStoredDraft = (tabId: string, draft: EditorDraft) => {
  if (typeof localStorage === "undefined") return;
  const drafts = getStoredDrafts();
  localStorage.setItem(EDITOR_DRAFTS_KEY, JSON.stringify({ ...drafts, [tabId]: draft }));
};

const removeStoredDraft = (tabId: string) => {
  if (typeof localStorage === "undefined") return;
  const drafts = getStoredDrafts();
  delete drafts[tabId];
  localStorage.setItem(EDITOR_DRAFTS_KEY, JSON.stringify(drafts));
};

const getInitialTabs = (): { activeTabId: string; tabs: EditorTab[] } => {
  if (typeof localStorage === "undefined") {
    return { activeTabId: "map", tabs: [DEFAULT_MAP_TAB] };
  }

  const editorState = loadWorkspaceEditorState();
  const drafts = getStoredDrafts();
  const restoredTabs = editorState.openEditorTabs
    .filter((tab) => tab.id === "map" || drafts[tab.id])
    .map<EditorTab>((tab) => tab.id === "map"
      ? DEFAULT_MAP_TAB
      : {
        closeable: true,
        dirty: true,
        id: tab.id,
        kind: "json",
        label: tab.label,
        value: drafts[tab.id]?.value
      });
  const tabs = restoredTabs.some((tab) => tab.id === "map") ? restoredTabs : [DEFAULT_MAP_TAB, ...restoredTabs];
  const activeTabId = tabs.some((tab) => tab.id === editorState.activeEditorTab) ? editorState.activeEditorTab : "map";
  return { activeTabId, tabs };
};

const getTabNavState = (tabs: EditorTab[]) => tabs.map(({ closeable, dirty, id, label }) => ({ closeable, dirty: Boolean(dirty), id, label }));

const getPageStatus = (tabs: EditorTab[], activeTabId: string) => {
  const activeTab = tabs.find((tab) => tab.id === activeTabId) || tabs[0];
  return {
    activePageTab: activeTab ? { id: activeTab.id, label: activeTab.label, closeable: Boolean(activeTab.closeable) } : null,
    openPageTabs: tabs.map((tab) => ({ id: tab.id, label: tab.label, closeable: Boolean(tab.closeable) }))
  };
};

const getAddressCoordinates = (address: unknown): [number, number] | null => {
  const value = address as any;
  const coordinateCandidates = [
    value?.coordinates,
    value?.center,
    value?.geometry?.coordinates,
    value?.geometry?.point,
    value?.location?.coordinates
  ];
  for (const candidate of coordinateCandidates) {
    if (Array.isArray(candidate) && candidate.length >= 2) {
      const lng = Number(candidate[0]);
      const lat = Number(candidate[1]);
      if (Number.isFinite(lng) && Number.isFinite(lat)) return [lng, lat];
    }
  }
  const lng = Number(value?.longitude ?? value?.lng ?? value?.lon);
  const lat = Number(value?.latitude ?? value?.lat);
  return Number.isFinite(lng) && Number.isFinite(lat) ? [lng, lat] : null;
};

const getAddressLabel = (address: unknown) => {
  const value = address as any;
  return String(value?.name || value?.address || value?.place_name || value?.formattedAddress || "Address");
};

const resolveMapboxUrl = (url: string, accessToken: string) => {
  const path = url.slice(9);
  let apiUrl;
  if (path.startsWith("fonts/")) {
    apiUrl = `https://api.mapbox.com/fonts/v1/${path.slice(6)}`;
  } else if (path.startsWith("sprites/")) {
    const spritePath = path.slice(8);
    const match = spritePath.match(/^(.+?)(@2x)?\.(json|png)$/);
    apiUrl = match
      ? `https://api.mapbox.com/styles/v1/${match[1]}/sprite${match[2] || ""}.${match[3]}`
      : `https://api.mapbox.com/styles/v1/${spritePath}/sprite`;
  } else {
    apiUrl = `https://api.mapbox.com/v4/${path}.json`;
  }
  return `${apiUrl}?access_token=${accessToken}`;
};

const buildMapboxTransform = (accessToken: string) => {
  return (url: string) => {
    if (url.startsWith("mapbox://")) {
      return { url: resolveMapboxUrl(url, accessToken) };
    }
    if (/api\.mapbox\.com|events\.mapbox\.com/.test(url)) {
      if (url.includes("access_token=")) return undefined;
      const sep = url.includes("?") ? "&" : "?";
      return { url: `${url}${sep}access_token=${accessToken}` };
    }
    return undefined;
  };
};

const normalizeTileCoordinateSystem = (tile: any, groundToBasemap = false) => {
  const coordinateSystem = tile.content?.coordinateSystem;
  const coordinateSystems: Record<number, string> = {
    0: "cartesian",
    1: "lnglat",
    2: "meter-offsets",
    3: "lnglat-offsets"
  };
  if (typeof coordinateSystem === "number") {
    tile.content.coordinateSystem = coordinateSystems[coordinateSystem];
  }
  if (groundToBasemap && tile.content?.cartographicOrigin) {
    const positions = tile.content.attributes?.positions?.value;
    if (!positions) return;
    let minZ = Infinity;
    for (let index = 2; index < positions.length; index += 3) {
      minZ = Math.min(minZ, positions[index]);
    }
    if (Number.isFinite(minZ)) tile.content.cartographicOrigin[2] = -minZ;
  }
};

const SceneLayerOverlay = ({ enabled, sceneLayer }: { enabled: boolean; sceneLayer?: SceneLayerConfig }) => {
  const overlay = useControl(() => new MapboxOverlay({ interleaved: true, layers: [] }) as any);

  useEffect(() => {
    overlay.setProps({
      layers: enabled && sceneLayer
        ? [new Tile3DLayer({
          id: sceneLayer.id,
          data: sceneLayer.url,
          loader: I3SLoader as any,
          loadOptions: {
            i3s: { coordinateSystem: COORDINATE_SYSTEM.LNGLAT_OFFSETS }
          },
          onTileLoad: (tile) => normalizeTileCoordinateSystem(tile, sceneLayer.groundToBasemap),
          onError: (error) => console.error(`[Map App] Failed to load ${sceneLayer.label || (sceneLayer as any).name}`, error)
        })]
        : []
    });
  }, [enabled, overlay, sceneLayer]);

  return null;
};

const EditorMap = ({ selectedAddress }: { selectedAddress: AddressMapSelection | null }) => {
  const mapRef = useRef<MapRef | null>(null);
  const [basemaps, setBasemaps] = useState<BasemapItem[]>([]);
  const [activeBasemapId, setActiveBasemapId] = useState("");
  const [mapStyle, setMapStyle] = useState<string | Record<string, any> | null>(null);
  const [terrain, setTerrain] = useState<TerrainConfig | undefined>();
  const [terrainEnabled, setTerrainEnabled] = useState(false);
  const [sceneLayers, setSceneLayers] = useState<SceneLayerConfig[]>([]);
  const [sceneEnabled, setSceneEnabled] = useState(false);
  const mapboxAccessToken = useMemo(() => getMapboxAccessToken(), []);
  const activeBasemap = basemaps.find((basemap) => basemap.id === activeBasemapId) || basemaps[0];

  const getDefaultBasemapId = (nextBasemaps: BasemapItem[]) => {
    return nextBasemaps.find((basemap) => basemap.style.type === "inline")?.id || nextBasemaps[0]?.id || "";
  };

  useEffect(() => {
    let cancelled = false;
    Promise.all([getBasemaps(), getTerrain(), getSceneLayers()])
      .then(([nextBasemaps, nextTerrain, nextSceneLayers]) => {
        if (cancelled) return;
        setBasemaps(nextBasemaps);
        setActiveBasemapId((current) => current || getDefaultBasemapId(nextBasemaps));
        setTerrain(nextTerrain);
        setSceneLayers(nextSceneLayers);
      })
      .catch((error) => console.error("[Map App] Failed to load map sources", error));

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!activeBasemap) return;
    let cancelled = false;
    getStyle(activeBasemap)
      .then((style) => {
        if (!cancelled) setMapStyle(style);
      })
      .catch((error) => console.error(`[Map App] Failed to load ${(activeBasemap as any).name || activeBasemap.label}`, error));
    return () => {
      cancelled = true;
    };
  }, [activeBasemap]);

  useEffect(() => {
    if (!selectedAddress || !mapRef.current) return;
    const map = mapRef.current.getMap();
    const bounds = map.getBounds();
    const point = selectedAddress.coordinates as any;
    if (!bounds?.contains?.(point)) {
      map.flyTo({ center: selectedAddress.coordinates, zoom: Math.max(map.getZoom(), 16), speed: 1.2 });
    }
  }, [selectedAddress]);

  if (!mapStyle) {
    return <div className="editor-map-loading">Loading map...</div>;
  }

  return (
    <Fragment>
      <Map
        ref={mapRef}
        initialViewState={DEFAULT_VIEW_STATE}
        mapLib={maplibregl}
        mapStyle={mapStyle as any}
        maxZoom={activeBasemap?.maxZoom}
        style={{ width: "100%", height: "100%" }}
        styleDiffing={false}
        transformRequest={mapboxAccessToken ? buildMapboxTransform(mapboxAccessToken) : undefined}
        terrain={terrainEnabled && terrain ? { source: terrain.id, exaggeration: terrain.exaggeration } : undefined}
        validateStyle={false}
        workerUrl={withBasePath("/maplibre-gl-worker.js")}
        onLoad={() => console.info("[Map App] MapLibre loaded")}
        onStyleData={(event) => {
          const style = event.target.getStyle?.();
          const source = Object.values(style?.sources || {})[0] as any;
          console.info("[Map App] MapLibre style data loaded", {
            basemap: (activeBasemap as any)?.name || activeBasemap?.label,
            layers: style?.layers?.length ?? 0,
            sources: Object.keys(style?.sources || {}).length,
            sourceTiles: source?.tiles?.slice?.(0, 2),
            sourceUrl: source?.url
          });
        }}
        onError={(event) => console.error("[Map App] MapLibre error", event.error || event)}
      >
        <NavigationControl position="top-right" />
        {terrain && terrainEnabled && (
          <Source
            id={terrain.id}
            type="raster-dem"
            tiles={terrain.tiles}
            tileSize={terrain.tileSize}
            maxzoom={terrain.maxZoom}
            attribution={terrain.attribution}
            encoding={terrain.encoding}
          />
        )}
        <SceneLayerOverlay enabled={sceneEnabled} sceneLayer={sceneLayers[0]} />
        {selectedAddress && (
          <Marker longitude={selectedAddress.coordinates[0]} latitude={selectedAddress.coordinates[1]} anchor="bottom" />
        )}
      </Map>
      <div className="map-display-settings editor-map-settings">
        <div className="map-display-group">
          <h3>Basemap</h3>
          <div className="map-display-options">
            {basemaps.map((basemap) => {
              const missingToken = basemap.requiresMapboxAccessToken && !mapboxAccessToken;
              return (
                <button
                  className={`map-display-option map-display-radio${basemap.id === activeBasemap?.id ? " is-active" : ""}${basemap.costly ? " has-money-icon" : ""}`}
                  disabled={missingToken}
                  key={basemap.id}
                  title={missingToken ? "Mapbox access token required" : ""}
                  type="button"
                  onClick={() => setActiveBasemapId(basemap.id)}
                >
                  {(basemap as any).name || basemap.label}
                </button>
              );
            })}
          </div>
        </div>
        <div className="map-display-group">
          <h3>Details</h3>
          <div className="map-display-detail">
            {terrain && (
              <button className={`map-display-option map-display-check${terrainEnabled ? " is-active" : ""}`} type="button" onClick={() => setTerrainEnabled((current) => !current)}>
                {(terrain as any).name || terrain.label}
              </button>
            )}
            {sceneLayers[0] && (
              <button className={`map-display-option map-display-check${sceneEnabled ? " is-active" : ""}`} type="button" onClick={() => setSceneEnabled((current) => !current)}>
                {(sceneLayers[0] as any).name || sceneLayers[0].label}
              </button>
            )}
          </div>
        </div>
      </div>
    </Fragment>
  );
};

const EditorPage = ({ activeTab, saveSignal, workspaceInvalidation, onDraftChange, onDirtyChange, onSaved }: { activeTab: EditorTab; saveSignal: number; workspaceInvalidation: WorkspaceInvalidationState; onDraftChange: (tabId: string, draft: EditorDraft) => void; onDirtyChange: (tabId: string, dirty: boolean) => void; onSaved: (tabId: string) => void }) => {
  const handleDraftChange = useCallback((draft: EditorDraft) => onDraftChange(activeTab.id, draft), [activeTab.id, onDraftChange]);
  const handleDirtyChange = useCallback((dirty: boolean) => onDirtyChange(activeTab.id, dirty), [activeTab.id, onDirtyChange]);
  const handleSaved = useCallback(() => onSaved(activeTab.id), [activeTab.id, onSaved]);

  if (activeTab.kind === "file") {
    return <FileViewer entry={activeTab.entry} />;
  }
  if (activeTab.kind === "pdf") {
    return <EditorPdfPanel label={activeTab.label} url={String(activeTab.value || "")} />;
  }
  if (activeTab.kind === "table") {
    return <EditorHtmlElementView element={activeTab.value as HTMLElement} />;
  }
  if (activeTab.kind === "graph") {
    return <RecordGraphView record={activeTab.value} />;
  }
  if (activeTab.kind === "json") {
    return (
      <EditorPanelItem
        featureId={activeTab.options?.featureId}
        fields={activeTab.options?.fields || []}
        initialDraft={getStoredDrafts()[activeTab.id]}
        initialMode={activeTab.options?.initialMode || "raw"}
        invalidation={activeTab.options?.featureId ? workspaceInvalidation[activeTab.options.featureId] : undefined}
        reload={activeTab.options?.reload}
        saveSignal={saveSignal}
        target={activeTab.options?.target}
        value={activeTab.value}
        onDraftChange={handleDraftChange}
        onDirtyChange={handleDirtyChange}
        onSave={activeTab.options?.onSave}
        onSaved={handleSaved}
      />
    );
  }
  return null;
};

const getNextActiveTabId = (tabs: EditorTab[], closingId: string, activeTabId: string) => {
  if (activeTabId !== closingId) return activeTabId;
  const index = tabs.findIndex((tab) => tab.id === closingId);
  return tabs[Math.max(0, index - 1)]?.id || "map";
};

export const EditorArea = ({ openAddressOnMapRef, openFileRef, openPageRef, suggestToolRef, workspaceInvalidation = {} }: EditorAreaProps = {}) => {
  const [tabs, setTabs] = useState<EditorTab[]>([DEFAULT_MAP_TAB]);
  const [activeTabId, setActiveTabId] = useState("map");
  const [saveSignal, setSaveSignal] = useState(0);
  const [selectedAddress, setSelectedAddress] = useState<AddressMapSelection | null>(null);
  const canPersistEditorStateRef = useRef(false);
  const activeTab = tabs.find((tab) => tab.id === activeTabId) || tabs[0] || DEFAULT_MAP_TAB;

  useEffect(() => {
    const initialState = getInitialTabs();
    setTabs(initialState.tabs);
    setActiveTabId(initialState.activeTabId);
    canPersistEditorStateRef.current = true;
  }, []);

  const openEditorTab = useCallback((tab: EditorTab, options: { activate?: boolean } = {}) => {
    setTabs((currentTabs) => {
      const existing = currentTabs.some((item) => item.id === tab.id);
      return existing
        ? currentTabs.map((item) => item.id === tab.id ? { ...item, ...tab } : item)
        : [...currentTabs, tab];
    });
    if (options.activate !== false) setActiveTabId(tab.id);
    if (tab.kind === "json") {
      saveStoredDraft(tab.id, {
        mode: tab.options?.initialMode === "rich" ? "list" : "raw",
        rawText: JSON.stringify(tab.value, null, 2),
        value: tab.value
      });
    }
  }, []);

  const closeTab = useCallback((id: string) => {
    const tab = tabs.find((item) => item.id === id);
    if (!tab?.closeable) return;
    if (tab.dirty && !window.confirm(`Discard unsaved changes to ${tab.label}?`)) return;
    removeStoredDraft(id);
    const nextActiveTabId = getNextActiveTabId(tabs, id, activeTabId);
    setTabs((currentTabs) => currentTabs.filter((item) => item.id !== id));
    setActiveTabId(nextActiveTabId);
  }, [activeTabId, tabs]);

  const updateDirty = useCallback((tabId: string, dirty: boolean) => {
    setTabs((currentTabs) => currentTabs.map((tab) => {
      if (tab.id !== tabId || Boolean(tab.dirty) === dirty) return tab;
      return { ...tab, dirty };
    }));
  }, []);

  const updateDraft = useCallback((tabId: string, draft: EditorDraft) => {
    saveStoredDraft(tabId, draft);
  }, []);

  const markSaved = useCallback((tabId: string) => {
    removeStoredDraft(tabId);
    updateDirty(tabId, false);
  }, [updateDirty]);

  useEffect(() => {
    if (!canPersistEditorStateRef.current) return;
    saveWorkspaceEditorState({
      openEditorTabs: tabs.map(({ id, label }) => ({ id, label })),
      activeEditorTab: activeTabId
    });
    window.dispatchEvent(new CustomEvent("research-agent:active-page", { detail: getPageStatus(tabs, activeTabId) }));
  }, [activeTabId, tabs]);

  useEffect(() => {
    if (!openPageRef) return;
    openPageRef.current = (id, label, value, options = {}) => {
      if (value === undefined) return;
      const pageOptions = options as JsonTabOptions;
      openEditorTab({
        closeable: true,
        id,
        kind: "json",
        label,
        options: {
          ...pageOptions,
          initialMode: pageOptions.rich ? "rich" : "raw"
        },
        value
      });
    };
  }, [openEditorTab, openPageRef]);

  useEffect(() => {
    if (!openFileRef) return;
    openFileRef.current = (entry: any) => {
      openEditorTab({
        closeable: true,
        entry,
        id: `file::${entry.key}`,
        kind: "file",
        label: entry.name || "File"
      });
    };
  }, [openEditorTab, openFileRef]);

  useEffect(() => {
    if (!openAddressOnMapRef) return;
    openAddressOnMapRef.current = (address: unknown) => {
      const coordinates = getAddressCoordinates(address);
      const label = getAddressLabel(address);
      openEditorTab({
        closeable: true,
        id: `address-${(address as any)?.id || label}`,
        kind: "json",
        label,
        options: { featureId: "address", initialMode: "raw", target: "item" },
        value: address
      }, { activate: false });
      setActiveTabId("map");
      if (coordinates) setSelectedAddress({ coordinates, item: address, label });
    };
  }, [openAddressOnMapRef, openEditorTab]);

  useEffect(() => {
    if (suggestToolRef) {
      suggestToolRef.current = () => {};
    }
  }, [suggestToolRef]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "s") return;
      if (activeTab.kind !== "json" || !activeTab.options?.onSave) return;
      event.preventDefault();
      setSaveSignal((current) => current + 1);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeTab]);

  return (
    <EditorPanel navbar={<EditorNavbar activeTabId={activeTabId} onActivateTab={setActiveTabId} onCloseTab={closeTab} tabs={getTabNavState(tabs)} />}>
      <div className="editor-viewport editor-viewport-react" id="editorViewport">
        <div className="editor-map-layer" id="map">
          <EditorMap selectedAddress={selectedAddress} />
        </div>
        {activeTab.kind !== "map" && (
          <div className="editor-page-overlay">
            <EditorPage
              activeTab={activeTab}
              saveSignal={saveSignal}
              workspaceInvalidation={workspaceInvalidation}
              onDraftChange={updateDraft}
              onDirtyChange={updateDirty}
              onSaved={markSaved}
            />
          </div>
        )}
      </div>
    </EditorPanel>
  );
};
