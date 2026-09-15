import { useEffect, useMemo, useState } from "react";
import { SearchWidget } from "@/components/primitives/SearchWidget";
import { SourceWidget, type SourceWidgetOption } from "@/components/primitives/SourceWidget";
import { getAddressSearchSources, getAddressData } from "@/features/address/address.api";
import { getAgentSearchSources, getAgentData } from "@/features/agent/agent.api";
import { getDatasetSearchSources, getDatasetData } from "@/features/dataset/dataset.api";
import { getFolderSearchSources, getFolderData } from "@/features/folder/folder.api";
import { getMapSearchSources, getMapData } from "@/features/map/map.api";
import { getProjectSearchSources, getProjectData } from "@/features/project/project.api";
import { getRecordSearchSources, getRecordData } from "@/features/record/record.api";
import { getSkillSearchSources, getSkillData } from "@/features/skill/skill.api";
import { getToolSearchSources, getToolData } from "@/features/tool/tool.api";
import { withBasePath } from "@/lib/basePath";
import { getFeatureLabel, type FeatureName } from "@/lib/features";
import { getWorkspaceFeatureInvalidation, type WorkspaceInvalidationScope, type WorkspaceInvalidationState } from "@/lib/workspaceInvalidation";
import { SidebarCard, type SidebarCardData } from "./SidebarCard";
import styles from "./Sidebar.module.css";

type SidebarPanelItemProps = {
  active: boolean;
  featureId: FeatureName;
  onOpenAddressOnMap?: (address: unknown) => void;
  onOpenPage?: (id: string, label: string, value: unknown, options?: unknown) => void;
  onInvalidateWorkspaceData?: (featureId: FeatureName, scopes: WorkspaceInvalidationScope | WorkspaceInvalidationScope[]) => void;
  onSelectAgentSession?: (session: { id: string }) => void;
  workspaceInvalidation?: WorkspaceInvalidationState;
};

type SidebarPanelCard = {
  id: string;
  data: SidebarCardData;
  ariaLabel?: string;
  openLabel?: string;
  onOpen?: () => void;
};

type FeatureItem = SidebarCardData & {
  id: string;
};

const getSearchSourcesByFeature: Record<string, () => Promise<Response>> = {
  address: getAddressSearchSources,
  agent: getAgentSearchSources,
  dataset: getDatasetSearchSources,
  folder: getFolderSearchSources,
  map: getMapSearchSources,
  project: getProjectSearchSources,
  record: getRecordSearchSources,
  skill: getSkillSearchSources,
  tool: getToolSearchSources
};

const getDataByFeature: Record<string, () => Promise<Response>> = {
  address: getAddressData,
  agent: getAgentData,
  dataset: getDatasetData,
  folder: getFolderData,
  map: getMapData,
  project: getProjectData,
  record: getRecordData,
  skill: getSkillData,
  tool: getToolData
};

export const SidebarPanelItem = ({ active, featureId, onOpenAddressOnMap, onOpenPage, onInvalidateWorkspaceData, onSelectAgentSession, workspaceInvalidation = {} }: SidebarPanelItemProps) => {
  const featureLabel = getFeatureLabel(featureId);
  const featureInvalidation = getWorkspaceFeatureInvalidation(workspaceInvalidation, featureId);
  const [searchSources, setSearchSources] = useState<SourceWidgetOption[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState("");
  const [featureItems, setFeatureItems] = useState<FeatureItem[]>([]);

  useEffect(() => {
    if (!active) return;

    const getSearchSources = getSearchSourcesByFeature[featureId];
    if (!getSearchSources) {
      setSearchSources([]);
      setSelectedSourceId("");
      return;
    }

    getSearchSources()
      .then((response) => (response.ok ? response.json() : []))
      .then((data) => {
        const sources = Array.isArray(data) ? data : [];
        setSearchSources(sources);
        setSelectedSourceId((current) => current || sources[0]?.id || "");
      })
      .catch(() => setSearchSources([]));
  }, [active, featureId, featureInvalidation.info]);

  const sourceOptions = searchSources;

  const selectedSource = sourceOptions.find((source) => source.id === selectedSourceId) || sourceOptions[0];
  const selectedSourceValue = selectedSource?.id || "";

  useEffect(() => {
    if (featureId !== "address" || !selectedSourceValue) return;
    window.dispatchEvent(new CustomEvent("research-agent:address-source-changed", {
      detail: { sourceId: selectedSourceValue }
    }));
  }, [featureId, selectedSourceValue]);

  useEffect(() => {
    if (!active) return;

    const getData = getDataByFeature[featureId];
    if (!getData) {
      setFeatureItems([]);
      return;
    }

    getData()
      .then((response) => (response.ok ? response.json() : []))
      .then((data) => setFeatureItems(Array.isArray(data) ? data : []))
      .catch(() => setFeatureItems([]));
  }, [active, featureId, featureInvalidation.info]);

  const cards = useMemo<SidebarPanelCard[]>(() => {
    return featureItems.map((item, index) => ({
      id: item.id || `${featureId}-item-${index}`,
      data: item,
      ariaLabel: item.name ?? item.id,
      openLabel: `Open ${item.name ?? item.id}`,
      onOpen: featureId === "agent"
        ? () => onSelectAgentSession?.({ id: item.id })
        : featureId === "address"
          ? () => onOpenAddressOnMap?.(item)
        : () => onOpenPage?.(`${featureId}-${item.id || index}`, item.name ?? item.id, item, {
        featureId,
        onSave: async (nextItem: unknown) => {
          const nextItems = replaceFeatureItem(featureItems, index, nextItem);
          await saveFeatureEditorPayload(featureId, "item", nextItems);
          setFeatureItems(nextItems as FeatureItem[]);
          onInvalidateWorkspaceData?.(featureId, ["info", "detail"]);
        },
        reload: () => reloadFeatureItem(featureId, item.id, index, item),
        target: "item"
      })
    }));
  }, [featureId, featureItems, onInvalidateWorkspaceData, onOpenAddressOnMap, onOpenPage, onSelectAgentSession]);

  function handleFeatureOpen() {
    const getData = getDataByFeature[featureId];
    getData?.()
      .then((response) => (response.ok ? response.json() : { error: `Could not load ${featureLabel} data.`, status: response.status }))
      .then((data) => onOpenPage?.(`${featureId}-data`, featureLabel, data, {
        featureId,
        onSave: async (nextData: unknown) => {
          await saveFeatureEditorPayload(featureId, "item", nextData);
          setFeatureItems(Array.isArray(nextData) ? nextData as FeatureItem[] : []);
          onInvalidateWorkspaceData?.(featureId, ["info", "detail"]);
        },
        reload: () => reloadFeatureData(featureId),
        target: "item"
      }))
      .catch((error) => onOpenPage?.(`${featureId}-data`, featureLabel, { error: error instanceof Error ? error.message : String(error) }));
  }

  function handleEditSources() {
    onOpenPage?.(`${featureId}-sources`, `${featureLabel} Sources`, searchSources, {
      featureId,
      onSave: async (nextSources: unknown) => {
        await saveFeatureEditorPayload(featureId, "searchSource", nextSources);
        setSearchSources(Array.isArray(nextSources) ? nextSources as SourceWidgetOption[] : []);
        onInvalidateWorkspaceData?.(featureId, "info");
      },
      reload: () => reloadSearchSources(featureId),
      target: "searchSource"
    });
  }

  return (
    <section
      className={`workspace-tab${active ? " is-active" : ""}`}
      id={`${featureId}Tab`}
      data-tab-panel
      hidden={!active}
    >
      <div className={styles.panelItemHeader}>
        <button
          type="button"
          className={styles.panelItemTitle}
          onClick={handleFeatureOpen}
          title={`List ${featureLabel} items`}
        >
          {featureLabel}
        </button>
        <SourceWidget
          options={sourceOptions}
          selectedId={selectedSourceValue}
          editLabel={`Edit ${featureLabel.toLowerCase()} sources`}
          onChange={(source) => setSelectedSourceId(source.id)}
          onEdit={handleEditSources}
        />
        <SearchWidget
          featureId={featureId}
          selectedSourceId={selectedSourceValue}
          accessToken={getSelectedSourceAccessToken(selectedSource)}
        />
      </div>
      <div className={styles.cardList}>
        {cards.map((card) => (
          <SidebarCard
            key={card.id}
            data={card.data}
            ariaLabel={card.ariaLabel}
            openLabel={card.openLabel}
            onOpen={card.onOpen}
          />
        ))}
      </div>
    </section>
  );
};

function getSelectedSourceAccessToken(source: SourceWidgetOption | undefined) {
  if (!source) return "";
  if (typeof localStorage === "undefined") return "";
  const accessKey = (source as any).access || ((source as any).type === "mapbox" ? "NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN" : "");
  if (!accessKey) return "";

  try {
    const settings = JSON.parse(localStorage.getItem("research-agent.settings") || "[]");
    if (!Array.isArray(settings)) return "";
    const setting = settings.find((item) => item?.key === accessKey);
    return typeof setting?.value === "string" ? setting.value : "";
  } catch {
    return "";
  }
}

async function saveFeatureEditorPayload(featureId: string, target: string, payload: unknown) {
  const response = await fetch(withBasePath(`/api/${featureId}${target === "searchSource" ? "?resource=sources" : ""}`), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.error || `Save failed with status ${response.status}`);
  }
}

async function reloadFeatureData(featureId: string) {
  const getData = getDataByFeature[featureId];
  if (!getData) return [];
  const response = await getData();
  return response.ok ? response.json() : [];
}

async function reloadFeatureItem(featureId: string, itemId: string, index: number, fallback: FeatureItem) {
  const data = await reloadFeatureData(featureId);
  if (!Array.isArray(data)) return fallback;
  return data.find((item) => item?.id && item.id === itemId) || data[index] || fallback;
}

async function reloadSearchSources(featureId: string) {
  const getSearchSources = getSearchSourcesByFeature[featureId];
  if (!getSearchSources) return [];
  const response = await getSearchSources();
  return response.ok ? response.json() : [];
}

function replaceFeatureItem(featureItems: FeatureItem[], index: number, nextItem: unknown) {
  if (!nextItem || typeof nextItem !== "object" || Array.isArray(nextItem)) return featureItems;

  const nextItemObject = nextItem as FeatureItem;
  const existingIndex = featureItems.findIndex((item, itemIndex) => (
    itemIndex !== index &&
    nextItemObject.id &&
    item.id === nextItemObject.id
  ));

  if (existingIndex >= 0) {
    return featureItems.map((item, itemIndex) => itemIndex === existingIndex ? nextItemObject : item).filter((_, itemIndex) => itemIndex !== index);
  }

  return featureItems.map((item, itemIndex) => itemIndex === index ? nextItemObject : item);
}
