import { createRoot } from "react-dom/client";
import { Fragment, useState } from "react";
import { getDatasetSearchSources, saveDatasetSearchSources } from "../dataset.api";
import { EditorActionsMenu } from "@/components/editor/EditorActionsMenu";
import { arcgisCatalogProvider } from "./providers/arcgis";
import { socrataCatalogProvider } from "./providers/socrata";

const DATASET_CATALOG_PROVIDERS = [
  arcgisCatalogProvider,
  socrataCatalogProvider
];

export function createCatalogController(editorTabController, agentController, getVariables, onAddSource, onCatalogsChanged = (_catalogs?: unknown) => {}) {
  let catalogs = [];
  let liveSaveTimer = null;
  let liveSaveInFlight = false;
  let liveSaveQueued = false;
  const inlineResultsByBubble = new WeakMap();
  const openCatalogIds = new Set();
  const catalogFieldElements = new Map();

  // ── Catalog registry panel ─────────────────────────────────────────────────

  const resultsPanel = document.createElement("div");
  resultsPanel.className = "search-catalog-results-panel";

  let saveStatusEl: HTMLSpanElement | null = null;

  const pageMenu = document.createElement("div");
  createRoot(pageMenu).render(
    <EditorActionsMenu
      left={(
        <Fragment>
          <button className="section-tool-button add-source-button" type="button" aria-label="Add catalog" title="Add catalog" onClick={addCatalog} />
          <span className="search-catalog-save-status" ref={(node) => { saveStatusEl = node; }} />
        </Fragment>
      )}
    />
  );

  const catalogListEl = document.createElement("div");
  catalogListEl.className = "search-catalog-card-list";

  const pageListView = document.createElement("div");
  pageListView.className = "page-view page-list-view";
  const pageListContent = document.createElement("div");
  pageListContent.className = "page-view-content page-list-view-content";
  pageListContent.appendChild(catalogListEl);
  pageListView.appendChild(pageListContent);
  resultsPanel.append(pageMenu, pageListView);

  // ── Catalog loading ────────────────────────────────────────────────────────────

  async function loadCatalogs() {
    try {
      const res = await getDatasetSearchSources();
      if (res.ok) {
        catalogs = normalizeCatalogs(await res.json());
        renderCatalogCards();
      }
    } catch (error) {
      console.error("[Catalog] Failed to load catalogs", error);
    }
  }

  function queueCatalogSync() {
    liveSaveQueued = true;
    setCatalogSaveStatus("Saving...", false);
    clearTimeout(liveSaveTimer);
    liveSaveTimer = setTimeout(syncCatalogsNow, 350);
  }

  async function syncCatalogsNow() {
    if (liveSaveInFlight || !liveSaveQueued) return;
    const serializedCatalogs = serializeCatalogs();
    liveSaveQueued = false;
    liveSaveInFlight = true;

    try {
      const res = await saveDatasetSearchSources(serializedCatalogs);

      if (!res.ok) {
        throw new Error(`Catalog save failed with status ${res.status}`);
      }

      catalogs = serializedCatalogs;
      notifyCatalogsChanged();
      setCatalogSaveStatus("Saved", true);
      setTimeout(() => {
        setCatalogSaveStatus("", false);
      }, 2000);
    } catch (error) {
      console.error("[Catalog] Live sync failed", error);
      setCatalogSaveStatus("Save failed", false);
      liveSaveQueued = true;
    } finally {
      liveSaveInFlight = false;
      if (liveSaveQueued) {
        clearTimeout(liveSaveTimer);
        liveSaveTimer = setTimeout(syncCatalogsNow, 1000);
      }
    }
  }

  function setCatalogSaveStatus(text: string, saved: boolean) {
    if (!saveStatusEl) return;
    saveStatusEl.textContent = text;
    saveStatusEl.classList.toggle("is-saved", saved);
  }

  function renderCatalogCards() {
    catalogListEl.replaceChildren();
    catalogFieldElements.clear();
    catalogs.forEach((catalog, index) => catalogListEl.appendChild(createCatalogCard(catalog, index)));
  }

  function createCatalogCard(catalog, index) {
    const card = document.createElement("details");
    card.className = "search-catalog-card";
    card.dataset.catalogId = catalog.id || `catalog-${Date.now()}`;

    if (!catalog.id) catalog.id = card.dataset.catalogId;
    card.open = openCatalogIds.has(catalog.id);
    card.addEventListener("toggle", () => {
      if (card.open) {
        openCatalogIds.add(catalog.id);
      } else {
        openCatalogIds.delete(catalog.id);
      }
    });

    const summary = document.createElement("summary");
    summary.className = "search-catalog-card-summary";

    const summaryText = document.createElement("div");
    summaryText.className = "search-catalog-card-summary-text";

    const title = document.createElement("strong");
    title.textContent = catalog.name || "New catalog";

    const summaryMeta = document.createElement("div");
    summaryMeta.className = "search-catalog-card-meta";

    const typeLabel = document.createElement("span");
    typeLabel.className = "search-catalog-type";
    typeLabel.textContent = getCatalogTypeLabel(catalog.type);

    const urlLabel = document.createElement("span");
    urlLabel.className = "search-catalog-url";
    urlLabel.textContent = catalog.url || "No URL";
    urlLabel.title = catalog.url || "";

    const removeBtn = document.createElement("button");
    removeBtn.className = "search-catalog-remove";
    removeBtn.type = "button";
    removeBtn.setAttribute("aria-label", "Remove catalog");
    removeBtn.title = "Remove catalog";
    removeBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      catalogs.splice(index, 1);
      openCatalogIds.delete(catalog.id);
      renderCatalogCards();
      notifyCatalogsChanged();
      queueCatalogSync();
    });

    summaryMeta.append(typeLabel, urlLabel);
    summaryText.append(title, summaryMeta);
    summary.append(summaryText, removeBtn);

    const fields = document.createElement("div");
    fields.className = "search-catalog-card-fields";

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "search-catalog-name-input";
    nameInput.placeholder = "Name";
    nameInput.value = catalog.name || "";

    const urlInput = document.createElement("input");
    urlInput.type = "text";
    urlInput.className = "search-catalog-url-input";
    urlInput.placeholder = "https://...";
    urlInput.value = catalog.url || "";

    const typeSelect = document.createElement("select");
    for (const { type: val, label } of DATASET_CATALOG_PROVIDERS) {
      const opt = document.createElement("option");
      opt.value = val;
      opt.textContent = label;
      opt.selected = (catalog.type || "arcgis") === val;
      typeSelect.appendChild(opt);
    }

    nameInput.addEventListener("input", () => {
      catalog.name = nameInput.value;
      title.textContent = catalog.name.trim() || "New catalog";
      notifyCatalogsChanged();
      queueCatalogSync();
    });
    urlInput.addEventListener("input", () => {
      catalog.url = urlInput.value;
      urlLabel.textContent = catalog.url.trim() || "No URL";
      urlLabel.title = catalog.url.trim();
      notifyCatalogsChanged();
      queueCatalogSync();
    });
    typeSelect.addEventListener("change", () => {
      catalog.type = normalizeCatalogProviderType(typeSelect.value);
      typeLabel.textContent = getCatalogTypeLabel(catalog.type);
      notifyCatalogsChanged();
      queueCatalogSync();
    });

    fields.append(
      createField("Name", nameInput),
      createField("URL", urlInput),
      createField("Type", typeSelect)
    );
    card.append(summary, fields);
    catalogFieldElements.set(catalog.id, { nameInput, urlInput, typeSelect });
    return card;
  }

  function createField(label, control) {
    const field = document.createElement("label");
    const fieldLabel = document.createElement("span");
    field.className = "search-catalog-field";
    fieldLabel.textContent = label;
    field.append(fieldLabel, control);
    return field;
  }

  function addCatalog() {
    const catalog = { id: `catalog-${Date.now()}`, name: "New catalog", url: "", type: "arcgis" };
    catalogs.push(catalog);
    openCatalogIds.add(catalog.id);
    renderCatalogCards();
    (catalogListEl.lastElementChild?.querySelector(".search-catalog-name-input") as HTMLElement | null)?.focus();
    notifyCatalogsChanged();
    queueCatalogSync();
  }

function getCatalogTypeLabel(type) {
    return getCatalogProvider(type).label;
  }

  function serializeCatalogs({ onlyValid = false } = {}) {
    collectCatalogFieldValues();
    const serializedCatalogs = catalogs
      .map((catalog) => ({
        ...catalog,
        id: catalog.id || `catalog-${Date.now()}`,
        name: (catalog.name || "").trim(),
        url: (catalog.url || "").trim().replace(/\/$/, ""),
        type: normalizeCatalogProviderType(catalog.type)
      }));

    return onlyValid ? serializedCatalogs.filter((h) => h.name && h.url) : serializedCatalogs;
  }

  function collectCatalogFieldValues() {
    catalogs.forEach((catalog) => {
      const elements = catalogFieldElements.get(catalog.id);
      if (!elements) return;
      catalog.name = elements.nameInput.value;
      catalog.url = elements.urlInput.value;
      catalog.type = elements.typeSelect.value;
    });
  }

  function notifyCatalogsChanged() {
    onCatalogsChanged(serializeCatalogs({ onlyValid: true }));
  }

  // ── Search context and agent events ────────────────────────────────────────

  function getCatalogContext() {
    const vars = getVariables?.() || {};
    return {
      catalogs: serializeCatalogs({ onlyValid: true }),
      supportedInputParams: getSupportedInputParamsByType(catalogs),
      locationContext: {
        coordinates: vars.selectedCoordinates ?? null,
        address: vars.selectedAddress ?? null
      }
    };
  }

  function handleCatalogEvent(event, bubble, thread) {
    clearThinkingText(bubble);
    if (event.type === "search_start") {
      appendSearchIndicator(thread, bubble, event.query, event.catalogName);
    } else if (event.type === "search_error") {
      appendSearchError(bubble, event.query, event.catalogName, event.message);
    } else if (event.type === "result") {
      let inlineResultsEl = inlineResultsByBubble.get(bubble);
      if (!inlineResultsEl) {
        inlineResultsEl = document.createElement("div");
        inlineResultsEl.className = "search-catalog-inline-results";
        bubble.appendChild(inlineResultsEl);
        inlineResultsByBubble.set(bubble, inlineResultsEl);
      }
      appendInlineResult(thread, inlineResultsEl, event.item);
    }
  }

  function appendInlineResult(thread, container, item) {
    const row = document.createElement("div");
    row.className = "search-catalog-inline-result";
    row.dataset.resultId = item.id;

    const titleEl = document.createElement("span");
    titleEl.className = "search-catalog-inline-result-title";
    titleEl.textContent = item.title;
    titleEl.title = item.title;

    const catalogEl = document.createElement("span");
    catalogEl.className = "search-catalog-inline-result-catalog";
    catalogEl.textContent = item.catalogName || "";

    const viewBtn = document.createElement("button");
    viewBtn.className = "search-catalog-inline-result-view";
    viewBtn.type = "button";
    viewBtn.textContent = "View";
    viewBtn.addEventListener("click", () => openDatasetTab(item));

    row.append(titleEl, catalogEl, viewBtn);
    container.appendChild(row);
    thread.scrollTop = thread.scrollHeight;
  }

  // ── Dataset detail tabs ────────────────────────────────────────────────────

  function openDatasetTab(item) {
    editorTabController.openSearchCatalogDatasetTab(item, <CatalogDatasetDetailPanel item={item} onAddSource={onAddSource} />);
  }

  // ── Agent thread helpers ───────────────────────────────────────────────────

  function appendSearchIndicator(thread, bubble, query, catalogName) {
    const row = document.createElement("div");
    row.className = "search-catalog-search-indicator";
    const icon = document.createElement("span");
    icon.className = "search-catalog-search-indicator-icon";
    const text = document.createTextNode(`Searching "${query}" on ${catalogName}...`);
    row.append(icon, text);
    bubble.appendChild(row);
    thread.scrollTop = thread.scrollHeight;
  }

  function appendSearchError(bubble, query, catalogName, message) {
    const row = document.createElement("div");
    row.className = "search-catalog-search-indicator search-catalog-search-error";
    row.textContent = `Search skipped for "${query}" on ${catalogName}: ${message}`;
    bubble.appendChild(row);
  }

  function clearThinkingText(bubble) {
    if (bubble.textContent === "Thinking…") bubble.textContent = "";
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  function open({ focusAgent = true } = {}) {
    editorTabController.openSearchCatalogResultsTab(resultsPanel);
    if (focusAgent) agentController.focusComposer("Ask about this place, records, or datasets");
  }

  loadCatalogs();
  agentController.setCatalogContextProvider(getCatalogContext);
  agentController.setCatalogEventHandler(handleCatalogEvent);

  return { open };
}

type CatalogDatasetDetailPanelProps = {
  item: Record<string, any>;
  onAddSource?: (item: Record<string, any>) => void;
};

export const CatalogDatasetDetailPanel = ({ item, onAddSource }: CatalogDatasetDetailPanelProps) => {
  const [added, setAdded] = useState(false);
  const meta = [
    ["Type", item.type || "Dataset"],
    ["Portal", item.portalType || "Catalog"],
    ["Owner", item.owner || "Unknown"],
    ["Identifier", item.id || "Unknown"],
    item.url ? ["URL", item.url] : null
  ].filter(Boolean) as [string, string][];

  return (
    <Fragment>
      <div className="search-catalog-detail-header">
        <div>
          <span className="search-catalog-detail-kicker">{item.catalogName || "Catalog dataset"}</span>
          <h2 className="search-catalog-detail-title">{item.title || "Untitled dataset"}</h2>
        </div>
        <div className="search-catalog-detail-actions">
          {item.url && (
            <a className="search-catalog-detail-link" href={item.url} rel="noopener noreferrer" target="_blank">
              Open source
            </a>
          )}
          <button
            className="search-catalog-detail-add"
            disabled={added}
            type="button"
            onClick={() => {
              onAddSource?.(item);
              setAdded(true);
            }}
          >
            {added ? "Added" : "Add source"}
          </button>
        </div>
      </div>
      <dl className="search-catalog-detail-meta">
        {meta.map(([label, value]) => (
          <Fragment key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </Fragment>
        ))}
      </dl>
      <section className="search-catalog-detail-section">
        <h3>Description</h3>
        <p>{item.snippet || "No description was provided by the catalog."}</p>
      </section>
    </Fragment>
  );
};

function normalizeCatalogs(value) {
  return Array.isArray(value) ? value.map((catalog) => ({
    ...catalog,
    type: normalizeCatalogProviderType(catalog.type),
    supportedInputParams: Array.isArray(catalog.supportedInputParams) ? catalog.supportedInputParams : getDefaultSupportedInputParams(catalog.type)
  })) : [];
}

function getSupportedInputParamsByType(catalogs) {
  return catalogs.reduce((acc, catalog) => {
    const type = normalizeCatalogProviderType(catalog.type);
    acc[type] ??= catalog.supportedInputParams || getDefaultSupportedInputParams(type);
    return acc;
  }, {});
}

function getDefaultSupportedInputParams(type) {
  return getCatalogProvider(type).supportedInputParams;
}

function getCatalogProvider(type) {
  return DATASET_CATALOG_PROVIDERS.find((provider) => provider.type === normalizeCatalogProviderType(type)) || DATASET_CATALOG_PROVIDERS[0];
}

function normalizeCatalogProviderType(type) {
  return type === "socrata" ? "socrata" : "arcgis";
}
