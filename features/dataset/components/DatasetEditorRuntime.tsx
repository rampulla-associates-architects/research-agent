import { queryUrl } from "@/features/map/components/providers/geojson";
import { Fragment } from "react";
import { createRoot } from "react-dom/client";
import { getAddressSearchSources } from "@/features/address/address.api";
import { getDatasetData, getDatasetSearchSources, saveDatasetData } from "../dataset.api";
import { EditorActionsMenu } from "@/components/editor/EditorActionsMenu";
import { arcgisCatalogProvider } from "./providers/arcgis";
import { socrataCatalogProvider } from "./providers/socrata";
import type { DatasetSourceType } from "../dataset.schema";

const DEFAULT_SUPPORTED_INPUT_PARAMS_BY_TYPE: Record<DatasetSourceType, readonly string[]> = {
  [arcgisCatalogProvider.sourceType]: arcgisCatalogProvider.supportedInputParams,
  [socrataCatalogProvider.sourceType]: socrataCatalogProvider.supportedInputParams
};

const LAYER_FIELDS_FOLDED_STORAGE_KEY = "research-agent.layerFieldsFolded";
const SOURCE_DELETE_GRACE_MS = 10_000;
const NEW_SOURCE_NAME = "New Source";
const NEW_SOURCE_DESCRIPTION = "New source description";

export function createDatasetController(builtinController, editorTabController, agentController) {
  const variables = {};
  const sourceElements = {};

  const sourceList = document.createElement("div");
  sourceList.id = "sourceList";

  const editorPanel = document.createElement("div");
  editorPanel.className = "editor-sources-panel";

  const pageMenu = document.createElement("div");
  createRoot(pageMenu).render(
    <EditorActionsMenu
      left={(
        <Fragment>
          <button className="section-tool-button add-source-button" type="button" aria-label="Add source" title="Add source" onClick={addDatasetSource} />
        </Fragment>
      )}
    />
  );
  editorPanel.append(pageMenu, sourceList);

  let datasetSources = [];
  let sourceIdToOpen = "";
  let supportedInputParamsByType = { ...DEFAULT_SUPPORTED_INPUT_PARAMS_BY_TYPE };
  let liveSaveTimer = null;
  let liveSaveInFlight = false;
  let liveSaveQueued = false;
  const sourceDeleteTimers = {};
  const sourceDeleteCountdownTimers = {};

  loadDatasetSources();
  loadSupportedInputParams();
  const openDatasetEditor = () => editorTabController.openDatasetTab(editorPanel);
  window.addEventListener("research-agent:edit-dataset-sources", openDatasetEditor);

  function renderSources(sources) {
    sources.forEach((source) => {
      if (source.isDeleted) {
        sourceList.appendChild(createDeletedSourceRow(source));
        return;
      }

      const elements = createSourceCard(source);
      sourceElements[source.id] = elements;
      sourceList.appendChild(elements.card);
    });
  }

  async function loadDatasetSources() {
    try {
      const response = await getDatasetData();

      if (!response.ok) {
        throw new Error(`Dataset registry failed with status ${response.status}`);
      }

      datasetSources = await response.json();
      renderSources(datasetSources);
      refreshAllParamColors();
    } catch (error) {
      console.error(error);
      await loadStaticDatasetSources();
    }
  }

  async function loadStaticDatasetSources() {
    try {
      const response = await getDatasetData();

      if (!response.ok) {
        throw new Error(`Static dataset registry failed with status ${response.status}`);
      }

      datasetSources = await response.json();
      renderSources(datasetSources);
      refreshAllParamColors();
    } catch (error) {
      console.error(error);
    }
  }

  function queueDatasetSync() {
    liveSaveQueued = true;
    clearTimeout(liveSaveTimer);
    liveSaveTimer = setTimeout(syncDatasetsNow, 350);
  }

  async function syncDatasetsNow() {
    if (liveSaveInFlight || !liveSaveQueued) return;
    const serializedSources = serializeDatasetSources();
    liveSaveQueued = false;
    liveSaveInFlight = true;

    try {
      const response = await saveDatasetData(serializedSources);

      if (!response.ok) {
        throw new Error(`Dataset save failed with status ${response.status}`);
      }

    } catch (error) {
      console.error("[Sources] Live sync failed", error);
      liveSaveQueued = true;
    } finally {
      liveSaveInFlight = false;
      if (liveSaveQueued) {
        clearTimeout(liveSaveTimer);
        liveSaveTimer = setTimeout(syncDatasetsNow, 1000);
      }
    }
  }

  async function reloadDatasetSources() {
    sourceList.replaceChildren();
    Object.keys(sourceElements).forEach((key) => {
      delete sourceElements[key];
    });
    await loadDatasetSources();
  }

  function addDatasetSource() {
    const source = createEmptyDatasetSource();
    datasetSources.push(source);
    sourceIdToOpen = source.id;
    queueDatasetSync();
    redrawDatasetSources();
  }

  function createEmptyDatasetSource() {
    const id = `source-${Date.now().toString(36)}`;

    return {
      id,
      name: "",
      description: "",
      type: "arcgis-feature-layer",
      method: "GET",
      overviewUrl: "",
      defaultParams: [],
      defaultOutputs: []
    };
  }

  function serializeDatasetSources() {
    return datasetSources.filter((source) => !source.isDeleted || source.deletePendingUntil).map((source) => {
      const elements = sourceElements[source.id];
      return serializeDatasetSource(source, elements);
    });
  }

  function serializeDatasetSource(source, elements) {
    const { isDeleted, deletePendingUntil, ...sourceForSave } = source;
    const overviewUrl = elements?.overviewUrlInput ? elements.overviewUrlInput.value.trim() : source.overviewUrl;
    const params = elements?.paramsGrid
      ? collectSourceRowPairs(elements.paramsGrid, "key", "value")
      : getEditableSourceParams(source);

    return {
      ...sourceForSave,
      name: elements?.titleInput ? elements.titleInput.value.trim() : source.name,
      description: elements?.descriptionInput ? elements.descriptionInput.value.trim() : source.description,
      overviewUrl: stripQueryString(overviewUrl),
      queryUrl: buildPersistedQueryUrl(source, overviewUrl, params),
      defaultParams: params.filter((row) => hasVariableToken(row.value)),
      defaultOutputs: elements?.outputsGrid ? collectSourceRowPairs(elements.outputsGrid, "variable", "path") : source.defaultOutputs,
      layerFields: source.layerFields || []
    };
  }

  function createDeletedSourceRow(source) {
    const row = document.createElement("div");
    const line = document.createElement("div");
    const label = document.createElement("span");
    const countdown = document.createElement("span");
    const revertButton = document.createElement("button");

    row.className = "source-deleted-row";
    line.className = "source-deleted-line";
    label.className = "source-deleted-label";
    countdown.className = "source-delete-countdown";
    label.textContent = `Deleted: ${source.name}`;
    updateDeleteCountdown(source, countdown);
    clearInterval(sourceDeleteCountdownTimers[source.id]);
    sourceDeleteCountdownTimers[source.id] = setInterval(() => {
      updateDeleteCountdown(source, countdown);
    }, 250);
    line.append(label, countdown);
    revertButton.className = "circle-icon-button revert-source-button";
    revertButton.type = "button";
    revertButton.setAttribute("aria-label", `Restore ${source.name}`);
    revertButton.title = `Restore ${source.name}`;
    revertButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      revertSourceDelete(source.id);
    });

    row.append(line, revertButton);
    return row;
  }

  function markSourceDeleted(source) {
    source.isDeleted = true;
    source.deletePendingUntil = Date.now() + SOURCE_DELETE_GRACE_MS;
    clearTimeout(sourceDeleteTimers[source.id]);
    sourceDeleteTimers[source.id] = setTimeout(() => {
      permanentlyDeleteSource(source.id);
    }, SOURCE_DELETE_GRACE_MS);
    redrawDatasetSources();
  }

  function revertSourceDelete(sourceId) {
    const source = datasetSources.find((candidate) => candidate.id === sourceId);

    if (!source) {
      return;
    }

    delete source.isDeleted;
    delete source.deletePendingUntil;
    clearTimeout(sourceDeleteTimers[sourceId]);
    clearInterval(sourceDeleteCountdownTimers[sourceId]);
    delete sourceDeleteTimers[sourceId];
    delete sourceDeleteCountdownTimers[sourceId];
    queueDatasetSync();
    redrawDatasetSources();
  }

  function permanentlyDeleteSource(sourceId) {
    clearTimeout(sourceDeleteTimers[sourceId]);
    clearInterval(sourceDeleteCountdownTimers[sourceId]);
    delete sourceDeleteTimers[sourceId];
    delete sourceDeleteCountdownTimers[sourceId];
    datasetSources = datasetSources.filter((source) => source.id !== sourceId);
    queueDatasetSync();
    redrawDatasetSources();
  }

  function redrawDatasetSources() {
    Object.keys(sourceDeleteCountdownTimers).forEach((sourceId) => {
      clearInterval(sourceDeleteCountdownTimers[sourceId]);
      delete sourceDeleteCountdownTimers[sourceId];
    });
    sourceList.replaceChildren();
    Object.keys(sourceElements).forEach((key) => {
      delete sourceElements[key];
    });
    renderSources(datasetSources);
    refreshAllParamColors();
  }

  function updateDeleteCountdown(source, element) {
    const remainingMs = Math.max(0, Number(source.deletePendingUntil || 0) - Date.now());
    element.textContent = `${Math.ceil(remainingMs / 1000)}s`;
  }

  function createSourceCard(source) {
    const card = document.createElement("details");
    const summary = document.createElement("summary");
    const summaryContent = document.createElement("div");
    const summaryMain = document.createElement("div");
    const summaryText = document.createElement("div");
    const summaryEdit = document.createElement("div");
    const deleteButton = document.createElement("button");
    const title = document.createElement("strong");
    const description = document.createElement("span");
    const titleInput = document.createElement("input");
    const descriptionInput = document.createElement("textarea");
    const body = document.createElement("div");
    const outputGrid = createGrid("Variable", "Path");
    const variableFooter = createSourceVariableFooter(source);
    const attachButton = createAttachButton(`Attach ${getSourceDisplayName(source)} to chat`, () => {
      agentController?.attachRecord(createSourceAttachment(source));
    });
    const saveSourceDraft = queueDatasetSync;
    const refreshSourceFooter = () => {
      updateSourceVariableFooter(variableFooter, source, paramsGrid && paramsGrid.rows, outputGrid.rows);
      updateCompactSourceCard(source);
    };
    const onSourceChange = () => {
      saveSourceDraft();
      refreshSourceFooter();
      refreshAllParamColors();
    };

    card.className = "source-editor";
    card.open = source.id === sourceIdToOpen;
    if (card.open) {
      sourceIdToOpen = "";
    }
    summary.className = "source-editor-summary";
    summaryContent.className = "source-editor-summary-content";
    summaryMain.className = "source-editor-summary-main";
    summaryText.className = "source-editor-summary-text";
    body.className = "source-editor-body";
    title.textContent = getSourceDisplayName(source);
    description.textContent = getSourceDisplayDescription(source);
    titleInput.className = "source-title-input";
    titleInput.type = "text";
    titleInput.value = source.name;
    descriptionInput.className = "source-description-input";
    descriptionInput.rows = 3;
    descriptionInput.value = source.description;
    deleteButton.className = "circle-icon-button delete-source-button source-editor-delete-button";
    deleteButton.type = "button";
    deleteButton.setAttribute("aria-label", `Delete ${source.name}`);
    deleteButton.title = `Delete ${source.name}`;
    deleteButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      markSourceDeleted(source);
    });

    const closeButton = document.createElement("button");
    closeButton.className = "circle-icon-button source-editor-close-button";
    closeButton.type = "button";
    closeButton.setAttribute("aria-label", "Close");
    closeButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      card.open = false;
    });

    summary.addEventListener("click", (event) => {
      if (card.open) {
        event.preventDefault();
      }
    });

    summaryText.append(title, description);
    summaryEdit.className = "source-summary-edit";
    summaryEdit.append(titleInput, descriptionInput);
    [titleInput, descriptionInput].forEach((input) => {
      input.addEventListener("click", (event) => event.stopPropagation());
      input.addEventListener("keydown", (event) => {
        const keyboardEvent = event as KeyboardEvent;
        event.stopPropagation();

        if (keyboardEvent.key === " ") {
          event.preventDefault();
          insertTextAtCursor(input, " ");
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
      });
      input.addEventListener("keyup", (event) => {
        const keyboardEvent = event as KeyboardEvent;
        event.stopPropagation();

        if (keyboardEvent.key === " ") {
          event.preventDefault();
        }
      });
      input.addEventListener("input", () => {
        source.name = titleInput.value;
        source.description = descriptionInput.value;
        title.textContent = titleInput.value.trim() || NEW_SOURCE_NAME;
        description.textContent = descriptionInput.value.trim() || NEW_SOURCE_DESCRIPTION;
        updateCompactSourceCard(source);
        saveSourceDraft();
      });
    });

    const syncButton = document.createElement("button");
    syncButton.className = "circle-icon-button sync-source-button source-editor-delete-button";
    syncButton.type = "button";
    syncButton.setAttribute("aria-label", `Sync ${source.name} metadata`);
    syncButton.title = "Pull fields and defaults from the source URL";

    syncButton.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();

      const url = (overviewUrlInput?.value?.trim() || source.overviewUrl || "").replace(/\/$/, "");
      if (!url) return;

      syncButton.disabled = true;
      syncButton.classList.remove("is-success", "is-error");

      try {
        const synced = isSocrataSourceUrl(url)
          ? await syncSocrataSource(url)
          : await syncArcGISSource(url);

        applySyncedSourceMetadata({
          synced,
          source,
          title,
          titleInput,
          description,
          descriptionInput,
          paramsGrid,
          outputGrid,
          overviewUrlInput,
          layerFieldsContainer,
          onSourceChange,
          getLayerFields,
          onFieldClick
        });

        onSourceChange();
        syncButton.classList.add("is-success");
        setTimeout(() => syncButton.classList.remove("is-success"), 2000);
      } catch (error) {
        console.error("[Sync] Failed", error);
        syncButton.classList.add("is-error");
        setTimeout(() => syncButton.classList.remove("is-error"), 2000);
      } finally {
        syncButton.disabled = false;
      }
    });

    const sideButtons = document.createElement("div");
    sideButtons.className = "source-editor-side-buttons";
    sideButtons.append(deleteButton, syncButton);
    summaryMain.appendChild(sideButtons);
    summaryMain.append(summaryText, summaryEdit);

    summaryMain.appendChild(closeButton);
    summaryContent.append(summaryMain, variableFooter);
    summary.append(attachButton, summaryContent);

    if (source.note) {
      body.appendChild(createNote(source.note));
    }

    let overviewUrlInput = null;
    let paramsGrid = null;
    let layerFieldsContainer = null;
    const getLayerFields = () => source.layerFields || [];
    const onFieldClick = (field) => {
      appendSourceRow(outputGrid.rows, "", defaultOutputPathForField(source, field), onSourceChange);
      onSourceChange();
    };

    overviewUrlInput = document.createElement("input");
    overviewUrlInput.className = "source-url-input";
    overviewUrlInput.type = "text";
    overviewUrlInput.value = source.overviewUrl || "";
    overviewUrlInput.addEventListener("input", () => {
      source.overviewUrl = overviewUrlInput.value.trim();
      source.type = inferDatasetSourceType(source.overviewUrl, source.type);
      mergeUrlParamsIntoGrid(paramsGrid?.rows, source.overviewUrl, onSourceChange, getLayerFields);
      onSourceChange();
    });

    body.append(createFieldGroup("Source URL", overviewUrlInput));

    paramsGrid = createGrid("Key", "Value");
    appendSection(body, "Input Settings", paramsGrid);
    getEditableSourceParams(source).forEach((row) => {
      appendParamRow(paramsGrid.rows, row.key, row.value, onSourceChange, getLayerFields);
    });

    const addParamBtn = document.createElement("button");
    addParamBtn.className = "record-action";
    addParamBtn.type = "button";
    addParamBtn.textContent = "Add parameter";
    addParamBtn.addEventListener("click", () => {
      appendParamRow(paramsGrid.rows, "", "", onSourceChange, getLayerFields);
      onSourceChange();
    });
    body.appendChild(addParamBtn);

    const inputTags = getSupportedInputParamsForSource(source);
    if (inputTags.length > 0) {
      body.appendChild(createInputParamTags(inputTags, paramsGrid.rows, onSourceChange, getLayerFields));
    }

    appendSection(body, "Output Settings", outputGrid);
    (source.defaultOutputs || []).forEach((row) => {
      appendSourceRow(outputGrid.rows, row.variable, row.path, onSourceChange);
    });
    body.appendChild(createAddButton("Add output", outputGrid.rows, onSourceChange));

    const layerFieldsToggle = document.createElement("button");
    layerFieldsContainer = document.createElement("div");
    const setLayerFieldsCollapsed = (collapsed) => {
      layerFieldsContainer.hidden = collapsed;
      layerFieldsToggle.classList.toggle("is-collapsed", collapsed);
      layerFieldsToggle.setAttribute("aria-expanded", String(!collapsed));
      layerFieldsToggle.setAttribute("aria-label", `${collapsed ? "Expand" : "Collapse"} output field tags`);
      layerFieldsToggle.title = `${collapsed ? "Expand" : "Collapse"} output field tags`;
    };
    layerFieldsToggle.className = "layer-fields-toggle";
    layerFieldsToggle.type = "button";
    layerFieldsToggle.addEventListener("click", () => {
      const collapsed = !layerFieldsContainer.hidden;
      setLayerFieldsCollapsed(collapsed);
      saveLayerFieldsCollapsed(source.id, collapsed);
    });
    body.append(layerFieldsToggle, layerFieldsContainer);
    renderLayerFields(layerFieldsContainer, source.layerFields, onFieldClick);
    setLayerFieldsCollapsed(getLayerFieldsCollapsed(source.id));

    card.append(summary, body);

    return {
      card,
      titleInput,
      descriptionInput,
      overviewUrlInput,
      paramsGrid: paramsGrid && paramsGrid.rows,
      outputsGrid: outputGrid.rows
    };
  }

  async function loadSupportedInputParams() {
    try {
      let res = await getDatasetSearchSources();
      if (!res.ok) {
        res = await getDatasetSearchSources();
      }
      if (!res.ok) return;
      const searchItems = await res.json();
      setSearchCatalogs(searchItems);
    } catch (error) {
      console.error("[Sources] Failed to load supported input params", error);
    }
  }

  function getSupportedInputParamsForSource(source) {
    const type = inferDatasetSourceType(source.overviewUrl || "", source.type);
    return supportedInputParamsByType[type] || DEFAULT_SUPPORTED_INPUT_PARAMS_BY_TYPE[type] || [];
  }

  function createSourceAttachment(source) {
    const elements = sourceElements[source.id];
    return {
      id: `source-attachment-${source.id}`,
      kind: "Source",
      title: elements?.titleInput?.value?.trim() || getSourceDisplayName(source),
      payload: {
        source: {
          ...source,
          name: elements?.titleInput?.value?.trim() || source.name,
          description: elements?.descriptionInput?.value?.trim() || source.description,
          overviewUrl: elements?.overviewUrlInput?.value?.trim() || source.overviewUrl,
          defaultParams: elements?.paramsGrid ? collectSourceRowPairs(elements.paramsGrid, "key", "value") : getEditableSourceParams(source),
          defaultOutputs: elements?.outputsGrid ? collectSourceRowPairs(elements.outputsGrid, "variable", "path") : source.defaultOutputs,
          layerFields: source.layerFields || []
        }
      }
    };
  }

  function updateCompactSourceCard(source) {
    window.dispatchEvent(new CustomEvent("research-agent:dataset-sources-changed"));
  }

  function openDatasetSourceRaw(source) {
    editorTabController.openRawJsonTab(
      `dataset-source-${source.id}`,
      getSourceDisplayName(source),
      serializeDatasetSource(source, sourceElements[source.id])
    );
  }

  function setVariable(name, value) {
    variables[name] = value;
  }

  async function assignSearchSourceOutputs(searchResult, sourceId) {
    const source = await getSearchSourceConfig(sourceId);
    const outputRows = Array.isArray(source?.outputs) ? source.outputs : [];
    const outputVariables = collectOutputVariablesFromRows(outputRows, searchResult, builtinController);
    const normalizedOutputVariables = {};

    Object.entries(outputVariables).forEach(([name, value]) => {
      normalizedOutputVariables[name] = normalizeVariableValue(value);
      setVariable(name, value);
    });

    return normalizedOutputVariables;
  }

  async function getSearchSourceConfig(sourceId) {
    if (!sourceId) return null;

    try {
      const response = await getAddressSearchSources();
      if (!response.ok) throw new Error(`Search source registry failed with status ${response.status}`);
      const sources = await response.json();
      return Array.isArray(sources) ? sources.find((source) => source.id === sourceId) : null;
    } catch (error) {
      console.error("[Sources] Failed to load search source outputs", error);
      return null;
    }
  }

  // ── Variable color helpers ────────────────────────────────────────────────

  // Returns Map<varName, sourceName> for all output variables defined by sources
  // other than excludeSourceId.
  function getAvailableOutputVarsFor(excludeSourceId) {
    const map = new Map();
    const allSources = datasetSources;

    for (const source of allSources) {
      if (source.id === excludeSourceId || source.isDeleted) continue;
      const sourceName = getSourceDisplayName(source);
      const els = sourceElements[source.id];

      if (els?.outputsGrid) {
        collectSourceRowPairs(els.outputsGrid, "variable", "path").forEach((p) => {
          if (p.variable && !map.has(p.variable)) map.set(p.variable, sourceName);
        });
      } else {
        (source.defaultOutputs || []).forEach((o) => {
          if (o.variable && !map.has(o.variable)) map.set(o.variable, sourceName);
        });
      }
    }

    return map;
  }

  function refreshAllParamColors() {
    const allSources = datasetSources;

    for (const source of allSources) {
      if (source.isDeleted) continue;
      const els = sourceElements[source.id];
      if (!els?.paramsGrid) continue;

      const availVars = getAvailableOutputVarsFor(source.id);
      const inputs = Array.from(els.paramsGrid.querySelectorAll("input"));

      // Grid alternates key/value — value inputs are at odd indices (1, 3, 5, …)
      for (let i = 1; i < inputs.length; i += 2) {
        applyParamValueColor(inputs[i], availVars);
      }
    }
  }

  function addSourceFromCatalog(item) {
      const source = {
        ...createEmptyDatasetSource(),
        name: item.title || "",
        description: item.snippet || "",
        type: item.portalType === "socrata" ? "socrata-dataset" : "arcgis-feature-layer",
        overviewUrl: normalizeLayerUrl(item.url, item.portalType) || ""
      };
    datasetSources.push(source);
    sourceIdToOpen = source.id;
    queueDatasetSync();
    redrawDatasetSources();
    editorTabController.openDatasetTab(editorPanel);
  }

  function normalizeLayerUrl(url, portalType) {
    if (!url) return "";
    if (portalType === "socrata") {
      return normalizeSocrataResourceUrl(url) || url;
    }
    // ArcGIS FeatureServer roots — default to layer 0
    if (portalType !== "socrata" && /\/FeatureServer\/?$/.test(url)) {
      return url.replace(/\/$/, "") + "/0";
    }
    return url;
  }

  function getVariables() {
    return { ...variables };
  }

  function reloadSearchCatalogs() {
    return loadSupportedInputParams();
  }

  function setSearchCatalogs(catalogs) {
    const datasetCatalogs = (Array.isArray(catalogs) ? catalogs : [])
      .filter((item) => (item.feature || item.activity) === "dataset");
    supportedInputParamsByType = {
      ...DEFAULT_SUPPORTED_INPUT_PARAMS_BY_TYPE,
      ...Object.fromEntries(
        datasetCatalogs.map((catalog) => [
          normalizeDatasetSourceType(catalog.type),
          catalog.supportedInputParams || []
        ])
      )
    } as typeof supportedInputParamsByType;
    redrawDatasetSources();
  }

  return {
    setVariable,
    assignSearchSourceOutputs,
    addSourceFromCatalog,
    getVariables,
    reloadSearchCatalogs,
    setSearchCatalogs
  };
}

async function syncArcGISSource(url) {
  const result = await queryUrl(`${url}?f=pjson`);

  if (!result.response?.fields) {
    throw new Error("ArcGIS metadata did not include a fields array.");
  }

  const layerInfo = result.response;
  const rawDesc = typeof layerInfo.description === "string" ? layerInfo.description : "";

  return {
    type: "arcgis-feature-layer",
    name: layerInfo.name || "",
    description: cleanDescription(rawDesc),
    fields: layerInfo.fields || [],
    params: getArcGISMetadataParams(layerInfo)
  };
}

async function syncSocrataSource(url) {
  const metadataUrl = getSocrataMetadataUrl(url);
  if (!metadataUrl) {
    throw new Error("Could not find a Socrata dataset id in the source URL.");
  }

  const result = await queryUrl(metadataUrl);
  const metadata = result.response || {};
  const columns = Array.isArray(metadata.columns) ? metadata.columns : [];
  const fields = columns
    .filter((column) => column.fieldName && !column.flags?.includes("hidden"))
    .map((column) => ({
      name: column.fieldName,
      alias: column.name || column.fieldName,
      type: column.dataTypeName || column.renderTypeName || "text",
      description: cleanDescription(column.description || "")
    }));

  return {
    type: "socrata-dataset",
    overviewUrl: getSocrataResourceUrl(url) || url,
    name: metadata.name || "",
    description: cleanDescription(metadata.description || metadata.metadata?.custom_fields?.Description || ""),
    fields,
    params: getSocrataMetadataParams(metadata),
    outputs: []
  };
}

function applySyncedSourceMetadata({
  synced,
  source,
  title,
  titleInput,
  description,
  descriptionInput,
  paramsGrid,
  outputGrid,
  overviewUrlInput,
  layerFieldsContainer,
  onSourceChange,
  getLayerFields,
  onFieldClick
}) {
  source.type = synced.type || source.type;

  if (synced.overviewUrl) {
    source.overviewUrl = synced.overviewUrl;
    if (overviewUrlInput) overviewUrlInput.value = synced.overviewUrl;
  }

  if (synced.name) {
    titleInput.value = synced.name;
    title.textContent = synced.name;
    source.name = synced.name;
  }

  if (synced.description) {
    descriptionInput.value = synced.description;
    description.textContent = synced.description;
    source.description = synced.description;
  }

  if (paramsGrid && Array.isArray(synced.params) && synced.params.length > 0) {
    paramsGrid.rows.replaceChildren();
    synced.params.forEach(([key, value]) => appendParamRow(paramsGrid.rows, key, value, onSourceChange, getLayerFields));
  }

  if (outputGrid && Array.isArray(synced.outputs)) {
    outputGrid.rows.replaceChildren();
    synced.outputs.forEach(([variable, path]) => appendSourceRow(outputGrid.rows, variable, path, onSourceChange));
  }

  source.defaultParams = paramsGrid ? collectSourceRowPairs(paramsGrid.rows, "key", "value") : source.defaultParams;
  source.defaultOutputs = outputGrid ? collectSourceRowPairs(outputGrid.rows, "variable", "path") : source.defaultOutputs;
  source.layerFields = synced.fields || [];

  if (layerFieldsContainer) renderLayerFields(layerFieldsContainer, source.layerFields, onFieldClick);
}

function getArcGISMetadataParams(layerInfo) {
  const params = [];

  if (layerInfo?.drawingInfo?.definitionExpression) {
    params.push(["where", layerInfo.drawingInfo.definitionExpression]);
  }

  if (layerInfo?.advancedQueryCapabilities?.supportsReturningGeometry === false) {
    params.push(["returnGeometry", "false"]);
  }

  return params;
}

function getSocrataMetadataParams(metadata) {
  const params = [];
  const query = metadata?.metadata?.jsonQuery || metadata?.metadata?.rowLabel;

  if (query && typeof query === "object") {
    if (query.limit) params.push(["$limit", String(query.limit)]);
    if (query.order) params.push(["$order", String(query.order)]);
    if (query.where) params.push(["$where", String(query.where)]);
    if (query.select) params.push(["$select", String(query.select)]);
  }

  return params;
}

function isSocrataSourceUrl(url) {
  try {
    const parsed = new URL(url);
    return /\/resource\/[a-z0-9]{4}-[a-z0-9]{4}\.json$/i.test(parsed.pathname)
      || /\/api\/views\/[a-z0-9]{4}-[a-z0-9]{4}/i.test(parsed.pathname)
      || /[a-z0-9]{4}-[a-z0-9]{4}/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function normalizeSocrataResourceUrl(url) {
  return getSocrataResourceUrl(url);
}

function getSocrataResourceUrl(url) {
  const parts = getSocrataUrlParts(url);
  return parts ? `${parts.origin}/resource/${parts.id}.json` : "";
}

function getSocrataMetadataUrl(url) {
  const parts = getSocrataUrlParts(url);
  return parts ? `${parts.origin}/api/views/${parts.id}.json` : "";
}

function getSocrataUrlParts(url) {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/([a-z0-9]{4}-[a-z0-9]{4})(?:\.json)?/i);
    if (!match) return null;
    return { origin: parsed.origin, id: match[1].toLowerCase() };
  } catch {
    return null;
  }
}

function getDatasetRequestUrl(source, baseUrl) {
  if (!baseUrl) return "";
  if (isSocrataSourceUrl(baseUrl)) {
    return normalizeSocrataResourceUrl(baseUrl) || baseUrl;
  }
  return `${baseUrl.replace(/\/query\/?$/, "").replace(/\/$/, "")}/query`;
}

function buildPersistedQueryUrl(source, overviewUrl, rows) {
  const cleanOverviewUrl = String(overviewUrl || source.overviewUrl || "").trim();
  const requestUrl = getDatasetRequestUrl(source, stripQueryString(cleanOverviewUrl));
  if (!requestUrl) return source.queryUrl || "";
  const mergedParams = new URLSearchParams();

  appendUrlParams(mergedParams, cleanOverviewUrl);
  appendUrlParams(mergedParams, source.queryUrl);
  rows.filter((row) => !hasVariableToken(row.value)).forEach((row) => {
    if (row.key) mergedParams.set(row.key, row.value);
  });

  let url;
  try {
    url = new URL(requestUrl);
  } catch {
    return source.queryUrl || requestUrl;
  }
  mergedParams.forEach((value, key) => url.searchParams.set(key, value));
  return url.toString();
}

function getEditableSourceParams(source) {
  const rows = new Map();
  appendUrlParamsToRows(rows, source.queryUrl);
  appendUrlParamsToRows(rows, source.overviewUrl);
  (source.defaultParams || []).forEach((row) => {
    if (row.key) rows.set(row.key, { key: row.key, value: String(row.value ?? "") });
  });
  return Array.from(rows.values());
}

function appendUrlParams(target, value) {
  if (!value) return;
  try {
    new URL(value).searchParams.forEach((paramValue, key) => target.set(key, paramValue));
  } catch {}
}

function appendUrlParamsToRows(target, value) {
  const params = new URLSearchParams();
  appendUrlParams(params, value);
  params.forEach((paramValue, key) => target.set(key, { key, value: paramValue }));
}

function mergeUrlParamsIntoGrid(grid, value, onChange, getLayerFields) {
  if (!grid) return;
  const existingRows = collectSourceRowPairs(grid, "key", "value");
  const existingKeys = new Set(existingRows.map((row) => row.key));
  const params = new URLSearchParams();
  appendUrlParams(params, value);
  params.forEach((paramValue, key) => {
    if (!existingKeys.has(key)) appendParamRow(grid, key, paramValue, onChange, getLayerFields);
  });
}

function stripQueryString(value) {
  if (!value) return "";
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return String(value).split(/[?#]/, 1)[0].replace(/\/$/, "");
  }
}

function hasVariableToken(value) {
  return /\{\{\s*[^}]+\s*\}\}/.test(String(value ?? ""));
}

function defaultOutputPathForField(source, field) {
  return isSocrataSourceUrl(source.overviewUrl || "") || source.type === "socrata-dataset"
    ? `0.${field.name}`
    : `features.0.properties.${field.name}`;
}

function inferDatasetSourceType(url, fallbackType = "arcgis-feature-layer") {
  if (!url) return normalizeDatasetSourceType(fallbackType);
  return isSocrataSourceUrl(url) ? "socrata-dataset" : "arcgis-feature-layer";
}

function normalizeDatasetSourceType(type: string | undefined): DatasetSourceType {
  return type === "socrata" || type === "socrata-dataset" ? "socrata-dataset" : "arcgis-feature-layer";
}

function cleanDescription(value) {
  return String(value || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function createAttachButton(label, onClick) {
  const button = document.createElement("button");
  button.className = "card-attach-button";
  button.type = "button";
  button.setAttribute("aria-label", label);
  button.title = label;
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });
  return button;
}

function createInputParamTags(params, grid, onChange, getLayerFields) {
  const container = document.createElement("div");
  container.className = "layer-fields-tags param-hint-tags";

  params.forEach((param) => {
    const tag = document.createElement("button");
    tag.className = "layer-fields-tag layer-fields-tag--clickable";
    tag.type = "button";
    tag.textContent = param;
    tag.addEventListener("click", () => {
      appendParamRow(grid, param, "", onChange, getLayerFields);
      onChange();
    });
    container.appendChild(tag);
  });

  return container;
}

// ── Suggestion popover (singleton) ────────────────────────────────────────────

let _suggestionPopover = null;
let _suggestionActiveInput = null;

function getSuggestionPopover() {
  if (!_suggestionPopover) {
    _suggestionPopover = document.createElement("div");
    _suggestionPopover.className = "param-suggestion-popover";
    _suggestionPopover.hidden = true;
    document.body.appendChild(_suggestionPopover);

    document.addEventListener("mousedown", (e) => {
      if (
        _suggestionActiveInput &&
        !_suggestionPopover.contains(e.target) &&
        e.target !== _suggestionActiveInput
      ) {
        hideSuggestionPopover();
      }
    }, true);
  }

  return _suggestionPopover;
}

function showSuggestionPopover(valueInput, keyName, layerFields) {
  const isOutFields = keyName === "outFields" && layerFields.length > 0;

  if (!isOutFields) {
    hideSuggestionPopover();
    return;
  }

  const popover = getSuggestionPopover();
  _suggestionActiveInput = valueInput;
  popover.replaceChildren();

  if (isOutFields) {
    const fieldOpts = document.createElement("div");
    fieldOpts.className = "param-suggestion-options";

    layerFields.forEach((field) => {
      const btn = document.createElement("button");
      btn.className = "param-suggestion-item";
      btn.type = "button";

      const nameSpan = document.createElement("span");
      nameSpan.textContent = field.name;

      const aliasSpan = document.createElement("span");
      aliasSpan.className = "param-suggestion-item-sub";
      aliasSpan.textContent = field.alias && field.alias !== field.name ? field.alias : "";

      btn.append(nameSpan, aliasSpan);
      btn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const parts = valueInput.value.split(",").map((s) => s.trim()).filter(Boolean);
        const idx = parts.indexOf(field.name);
        if (idx === -1) parts.push(field.name); else parts.splice(idx, 1);
        valueInput.value = parts.join(", ");
        valueInput.dispatchEvent(new Event("input", { bubbles: true }));
        // keep popover open for multi-select
      });
      fieldOpts.appendChild(btn);
    });

    popover.appendChild(fieldOpts);
  }

  const rect = valueInput.getBoundingClientRect();
  popover.style.top = `${rect.bottom + 4}px`;
  popover.style.left = `${rect.left}px`;
  popover.style.minWidth = `${rect.width}px`;
  popover.hidden = false;
}

function hideSuggestionPopover() {
  if (_suggestionPopover) _suggestionPopover.hidden = true;
  _suggestionActiveInput = null;
}

// ── appendParamRow — like appendSourceRow but with ArcGIS suggestion popover ──

function appendParamRow(grid, key = "", value = "", onChange = () => {}, getLayerFields = () => []) {
  const keyInput = document.createElement("input");
  const valueInput = document.createElement("input");

  keyInput.type = "text";
  valueInput.type = "text";
  keyInput.value = key;
  valueInput.value = value;

  function refreshHint() {
    showSuggestionPopover(valueInput, keyInput.value.trim(), getLayerFields());
  }

  keyInput.addEventListener("input", () => {
    if (document.activeElement === valueInput) refreshHint();
    onChange();
  });

  valueInput.addEventListener("focus", refreshHint);
  valueInput.addEventListener("input", onChange);
  valueInput.addEventListener("blur", () => {
    setTimeout(() => {
      if (!_suggestionPopover?.contains(document.activeElement)) hideSuggestionPopover();
    }, 150);
  });

  const deleteBtn = createRowDeleteButton(() => {
    keyInput.remove();
    valueInput.remove();
    deleteBtn.remove();
    onChange();
  });

  grid.append(keyInput, valueInput, deleteBtn);
}

// ── Layer fields renderer ─────────────────────────────────────────────────────

function renderLayerFields(container, fields, onFieldClick = null) {
  container.replaceChildren();

  if (!fields || fields.length === 0) {
    const note = document.createElement("p");
    note.className = "source-note";
    note.textContent = "No fields synced yet — use the sync button with an Overview URL.";
    container.appendChild(note);
    return;
  }

  const tags = document.createElement("div");
  tags.className = "layer-fields-tags";

  fields.forEach((field) => {
    const tag = document.createElement("span");
    tag.className = `layer-fields-tag${onFieldClick ? " layer-fields-tag--clickable" : ""}`;
    tag.textContent = `${field.name} (${formatEsriFieldType(field.type)})`;
    tag.title = field.alias && field.alias !== field.name ? field.alias : field.name;
    if (onFieldClick) tag.addEventListener("click", () => onFieldClick(field));
    tags.appendChild(tag);
  });

  container.appendChild(tags);
}

function getLayerFieldsCollapsed(sourceId) {
  try {
    const preferences = JSON.parse(localStorage.getItem(LAYER_FIELDS_FOLDED_STORAGE_KEY) || "{}");
    return preferences[sourceId] ?? true;
  } catch {
    return true;
  }
}

function saveLayerFieldsCollapsed(sourceId, collapsed) {
  try {
    const preferences = JSON.parse(localStorage.getItem(LAYER_FIELDS_FOLDED_STORAGE_KEY) || "{}");
    preferences[sourceId] = collapsed;
    localStorage.setItem(LAYER_FIELDS_FOLDED_STORAGE_KEY, JSON.stringify(preferences));
  } catch {}
}

function formatEsriFieldType(esriType) {
  return (esriType || "").replace("esriFieldType", "");
}

function applyParamValueColor(input, availableVars) {
  const tokens = [...input.value.matchAll(/\{\{([^}]+)\}\}/g)].map((m) => m[1].trim());

  if (tokens.length === 0) {
    input.classList.remove("param-value-resolved", "param-value-unresolved");
    input.removeAttribute("title");
    return;
  }

  const allResolved = tokens.every((t) => availableVars.has(t));
  input.classList.toggle("param-value-resolved", allResolved);
  input.classList.toggle("param-value-unresolved", !allResolved);

  input.title = tokens
    .map((t) => {
      const source = availableVars.get(t);
      return source ? `${t} — ${source}` : `${t} — not defined`;
    })
    .join("\n");
}

function createFieldGroup(labelText, input) {
  const group = document.createElement("div");
  group.className = "source-field-group";
  const label = document.createElement("label");
  label.className = "field-label";
  label.textContent = labelText;
  group.append(label, input);
  return group;
}

function appendSection(body, title, grid) {
  const heading = document.createElement("h3");
  heading.className = "subsection-title";
  heading.textContent = title;
  body.append(heading, grid.heading, grid.rows);
}

function createGrid(firstHeading, secondHeading) {
  const heading = document.createElement("div");
  const rows = document.createElement("div");
  const first = document.createElement("span");
  const second = document.createElement("span");

  heading.className = "source-grid source-grid-heading";
  rows.className = "source-grid";
  first.textContent = firstHeading;
  second.textContent = secondHeading;
  heading.append(first, second, document.createElement("span")); // spacer for delete column

  return { heading, rows };
}

function createNote(text) {
  const note = document.createElement("p");
  note.className = "source-note";
  note.textContent = text;
  return note;
}

function insertTextAtCursor(input, text) {
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  input.setRangeText(text, start, end, "end");
}

function getSourceDisplayName(source) {
  return source.name || NEW_SOURCE_NAME;
}

function getSourceDisplayDescription(source) {
  return source.description || NEW_SOURCE_DESCRIPTION;
}

function createSourceVariableFooter(source) {
  const footer = document.createElement("div");

  footer.className = "source-variable-footer";
  updateSourceVariableFooter(footer, source);
  return footer;
}

function updateSourceVariableFooter(footer, source, paramsGrid = null, outputsGrid = null) {
  const inputNames = paramsGrid
    ? collectSourceRowPairs(paramsGrid, "key", "value").flatMap((row) => extractVariableTokens(row.value))
    : getInputVariableNames(source);
  const outputNames = outputsGrid ? collectSourceRowPairs(outputsGrid, "variable", "path").map((row) => row.variable).filter(Boolean) : getOutputVariableNames(source);

  footer.replaceChildren(
    createVariableList("Inputs", inputNames),
    createVariableList("Outputs", outputNames)
  );
}

function createVariableList(title, names) {
  const section = document.createElement("div");
  const heading = document.createElement("strong");
  const table = document.createElement("table");
  const body = document.createElement("tbody");

  section.className = "source-variable-list";
  heading.textContent = title;

  if (names.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.textContent = "None";
    row.appendChild(cell);
    body.appendChild(row);
  } else {
    names.forEach((name) => {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.textContent = name;
      row.appendChild(cell);
      body.appendChild(row);
    });
  }

  table.appendChild(body);
  section.append(heading, table);
  return section;
}

function getInputVariableNames(source) {
  return (source.defaultParams || []).flatMap((row) => extractVariableTokens(row.value));
}

// Returns the inner names of all {{varName}} tokens in a string, stripping the braces.
function extractVariableTokens(value) {
  if (!value) return [];
  return [...value.matchAll(/\{\{([^}]+)\}\}/g)].map((m) => m[1].trim());
}

function getOutputVariableNames(source) {
  return (source.defaultOutputs || [])
    .map((row) => row.variable)
    .filter(Boolean);
}

function createAddButton(label, grid, onChange) {
  const button = document.createElement("button");
  button.className = "record-action";
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", () => {
    appendSourceRow(grid, "", "", onChange);
    onChange();
  });
  return button;
}

function createRowDeleteButton(onClick) {
  const btn = document.createElement("button");
  btn.className = "row-delete-button";
  btn.type = "button";
  btn.setAttribute("aria-label", "Remove row");
  btn.addEventListener("click", onClick);
  return btn;
}

function appendSourceRow(grid, key = "", value = "", onChange = () => {}) {
  const keyInput = document.createElement("input");
  const valueInput = document.createElement("input");
  const deleteBtn = createRowDeleteButton(() => {
    keyInput.remove();
    valueInput.remove();
    deleteBtn.remove();
    onChange();
  });

  keyInput.type = "text";
  valueInput.type = "text";
  keyInput.value = key;
  valueInput.value = value;
  keyInput.addEventListener("input", onChange);
  valueInput.addEventListener("input", onChange);

  grid.append(keyInput, valueInput, deleteBtn);
}

function collectSourceRowPairs(grid, firstKey, secondKey) {
  const inputs = Array.from(grid.querySelectorAll("input")) as HTMLInputElement[];
  const rows = [];

  for (let index = 0; index < inputs.length; index += 2) {
    const firstValue = inputs[index].value.trim();
    const secondValue = inputs[index + 1].value.trim();

    if (firstValue || secondValue) {
      rows.push({
        [firstKey]: firstValue,
        [secondKey]: secondValue
      });
    }
  }

  return rows;
}

function collectOutputVariablesFromRows(rows, response, builtinController) {
  const outputVariables = {};

  rows.forEach((row) => {
    const variableName = String(row.variable || "").trim();
    const expression = String(row.path || "").trim();

    if (expression && variableName) {
      outputVariables[variableName] = evaluateOutputExpression(response, expression, builtinController, outputVariables);
    }
  });

  return outputVariables;
}

function evaluateOutputExpression(response, expression, builtinController, computedVariables = {}) {
  const builtinMatch = expression.match(/^([A-Za-z_$][\w$]*)\((.*)\)$/);

  if (builtinMatch && builtinController?.has(builtinMatch[1])) {
    const argExprs = parseBuiltinArgs(builtinMatch[2]);
    const argValues = argExprs.map((arg) => resolveBuiltinArg(arg, response, computedVariables));
    return builtinController.apply(builtinMatch[1], argValues);
  }

  if (Object.prototype.hasOwnProperty.call(computedVariables, expression)) {
    return computedVariables[expression];
  }

  return getValueAtPath(response, expression);
}

function parseBuiltinArgs(argsStr) {
  const args = [];
  let current = "";
  let inString = false;
  let depth = 0;

  for (let i = 0; i < argsStr.length; i++) {
    const ch = argsStr[i];
    if (inString) {
      if (ch === '"') inString = false;
      current += ch;
    } else if (ch === '"') {
      inString = true;
      current += ch;
    } else if (ch === "(" || ch === "[") {
      depth++;
      current += ch;
    } else if (ch === ")" || ch === "]") {
      depth--;
      current += ch;
    } else if (ch === "," && depth === 0) {
      args.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }

  const last = current.trim();
  if (last) args.push(last);
  return args;
}

function resolveBuiltinArg(arg, response, computedVariables) {
  if (arg.startsWith('"') && arg.endsWith('"') && arg.length >= 2) {
    return arg.slice(1, -1);
  }
  if (/^-?\d+(\.\d+)?$/.test(arg)) {
    return Number(arg);
  }
  if (Object.prototype.hasOwnProperty.call(computedVariables, arg)) {
    return computedVariables[arg];
  }
  const fromComputed = getValueAtPath(computedVariables, arg);
  if (fromComputed !== undefined) return fromComputed;
  const fromResponse = getValueAtPath(response, arg);
  if (fromResponse !== undefined) return fromResponse;
  return arg;
}

function getValueAtPath(value, path) {
  const parts = path.split(".").filter(Boolean);
  const values = getValuesAtPath(value, parts);

  if (values.length === 0) {
    return undefined;
  }

  return values.length === 1 ? values[0] : values;
}

function getValuesAtPath(value, parts) {
  if (!parts.length) {
    return value === undefined ? [] : [value];
  }

  if (value === null || value === undefined) {
    return [];
  }

  const [part, ...rest] = parts;

  if (part === "*") {
    const items = Array.isArray(value) ? value : Object.values(value);
    return items.flatMap((item) => getValuesAtPath(item, rest));
  }

  if (Array.isArray(value) && !/^\d+$/.test(part)) {
    return value.flatMap((item) => getValuesAtPath(item, parts));
  }

  return getValuesAtPath(value[part], rest);
}

function normalizeVariableValue(value) {
  if (Array.isArray(value)) {
    return value.join(",");
  }

  if (value === null || value === undefined) {
    return "";
  }

  return String(value);
}
