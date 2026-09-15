import { Fragment, useEffect, useRef, useState, type CSSProperties } from "react";
import { withBasePath } from "@/lib/basePath";
import type { EditorField } from "@/lib/editorSchema";
import { loadWorkspaceSettings } from "@/lib/workspaceSettings";
import type { WorkspaceFeatureInvalidation } from "@/lib/workspaceInvalidation";
import { EditorActionsMenu } from "./EditorActionsMenu";
import { RecursiveDictEditor, RecursiveListEditor } from "./RecursiveEditorValue";

type EditorJsonMode = "raw" | "list" | "table" | "graph";

type EditorPanelItemProps = {
  featureId?: string;
  fields?: readonly EditorField[];
  initialDraft?: {
    mode: EditorJsonMode;
    rawText: string;
    value: unknown;
  };
  initialMode?: "raw" | "rich";
  invalidation?: WorkspaceFeatureInvalidation;
  onSave?: (value: unknown) => Promise<unknown> | unknown;
  onDraftChange?: (draft: { mode: EditorJsonMode; rawText: string; value: unknown }) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onSaved?: () => void;
  reload?: () => Promise<unknown>;
  saveSignal?: number;
  target?: string;
  value: unknown;
};

const viewButtons = [
  { mode: "raw", label: "Raw", icon: "raw" },
  { mode: "list", label: "List", icon: "list" },
  { mode: "table", label: "Table", icon: "table" },
  { mode: "graph", label: "Graph", icon: "graph" }
] as const;

export const EditorPanelItem = ({ featureId, fields = [], initialDraft, initialMode = "raw", invalidation, onDraftChange, onDirtyChange, onSave, onSaved, reload, saveSignal = 0, target = "item", value }: EditorPanelItemProps) => {
  const initialStructuredValue = getStructuredValue(value);
  const initialJsonMode = initialMode === "rich" ? "list" : "raw";
  const lastInvalidationKeyRef = useRef<string | null>(null);
  const [mode, setMode] = useState<EditorJsonMode>(initialDraft?.mode || (initialStructuredValue ? initialJsonMode : "raw"));
  const [editable, setEditable] = useState(false);
  const [savedValue, setSavedValue] = useState<unknown>(initialStructuredValue ?? {});
  const [draft, setDraft] = useState<unknown>(initialDraft?.value ?? initialStructuredValue ?? {});
  const [rawText, setRawText] = useState(() => initialDraft?.rawText || JSON.stringify(value, null, 2));
  const [editorFields, setEditorFields] = useState<readonly EditorField[]>(fields);
  const [status, setStatus] = useState("");
  const support = getViewSupport(draft);
  const isDirty = getEditorDirtyState({ draft, mode, rawText, savedValue });
  const isDirtyRef = useRef(isDirty);

  useEffect(() => {
    isDirtyRef.current = isDirty;
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

  useEffect(() => {
    onDraftChange?.({ mode, rawText, value: draft });
  }, [draft, mode, onDraftChange, rawText]);

  useEffect(() => {
    const nextStructuredValue = getStructuredValue(value);
    setSavedValue(nextStructuredValue ?? {});
    if (!initialDraft) {
      setDraft(nextStructuredValue ?? {});
      setRawText(JSON.stringify(value, null, 2));
    }
  }, [initialDraft, value]);

  useEffect(() => {
    setEditorFields(fields);
  }, [fields]);

  useEffect(() => {
    if (!featureId) return;

    let cancelled = false;
    fetch(withBasePath(`/api/${featureId}?resource=schema&target=${target}`))
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (cancelled || !Array.isArray(data?.fields)) return;
        setEditorFields(data.fields);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [featureId, target]);

  useEffect(() => {
    const invalidationKey = `${invalidation?.info ?? 0}:${invalidation?.detail ?? 0}`;
    if (lastInvalidationKeyRef.current === null) {
      lastInvalidationKeyRef.current = invalidationKey;
      return;
    }
    if (lastInvalidationKeyRef.current === invalidationKey || !reload) return;

    lastInvalidationKeyRef.current = invalidationKey;
    let cancelled = false;
    reload()
      .then((nextValue) => {
        if (cancelled || nextValue === undefined) return;
        const nextStructuredValue = getStructuredValue(nextValue);
        const nextSavedValue = nextStructuredValue ?? {};
        setSavedValue(nextSavedValue);
        if (!isDirtyRef.current) {
          setDraft(nextSavedValue);
          setRawText(JSON.stringify(nextValue, null, 2));
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [invalidation?.detail, invalidation?.info, reload]);

  const showRawView = () => {
    setRawText(JSON.stringify(draft, null, 2));
    setMode("raw");
    setStatus("");
  };

  const showJsonView = (nextMode: Exclude<EditorJsonMode, "raw">) => {
    try {
      const parsed = JSON.parse(rawText);
      const nextDraft = getStructuredValue(parsed);
      if (!nextDraft) {
        setStatus("This view needs a JSON object or array.");
        return;
      }
      setDraft(nextDraft);
      setMode(nextMode);
      setStatus("");
    } catch {
      setStatus("Raw JSON is invalid.");
    }
  };

  const setDraftValue = (nextValue: unknown) => {
    setDraft(nextValue);
    setRawText(JSON.stringify(nextValue, null, 2));
  };

  const save = async () => {
    let payload: unknown = getSavePayload(draft);
    if (mode === "raw") {
      try {
        const parsed = JSON.parse(rawText);
        payload = getSavePayload(parsed);
        if (payload === null) {
          setStatus("Save needs a JSON object or array.");
          return;
        }
        setDraft(payload);
      } catch {
        setStatus("Raw JSON is invalid.");
        return;
      }
    }

    if (payload === null) {
      setStatus("Save needs a JSON object or array.");
      return;
    }

    try {
      setStatus("Saving...");
      await onSave?.(payload);
      setSavedValue(payload);
      setRawText(JSON.stringify(payload, null, 2));
      setStatus("Saved");
      onSaved?.();
    } catch (error) {
      console.error("[EditorPanelItem] Save failed", error);
      setStatus("Save failed");
    }
  };

  useEffect(() => {
    if (saveSignal <= 0 || !onSave) return;
    void save();
  }, [saveSignal]);

  return (
    <div className={`page-view editor-json-view editor-json-view-${mode}`}>
      <EditorActionsMenu
        left={(
          <Fragment>
            {viewButtons.map((button) => (
              <ViewButton
                active={mode === button.mode}
                disabled={button.mode !== "raw" && !support[button.mode]}
                icon={button.icon}
                key={button.mode}
                label={button.label}
                onClick={button.mode === "raw" ? showRawView : () => showJsonView(button.mode)}
              />
            ))}
          </Fragment>
        )}
        right={(
          <Fragment>
            <ViewButton active={editable} disabled={!support.list} icon="edit" label="Edit" onClick={() => setEditable((current) => !current)} />
            {onSave && (
              <button className="record-action" type="button" onClick={save}>
                Save
              </button>
            )}
            {status && <span className="editor-rich-status">{status}</span>}
          </Fragment>
        )}
      />
      {mode === "raw" && (
        <RawJsonBody rawText={rawText} editable={support.list} setRawText={setRawText} />
      )}
      {mode === "list" && (
        <EditorFormBody
          draft={draft}
          editable={editable}
          fields={editorFields}
          savedValue={savedValue}
          setDraftValue={setDraftValue}
        />
      )}
      {mode === "table" && <TableJsonBody value={draft} />}
      {mode === "graph" && <GraphJsonBody value={draft} />}
    </div>
  );
};

const ViewButton = ({ active, disabled = false, icon, label, onClick }: { active: boolean; disabled?: boolean; icon: string; label: string; onClick: () => void }) => {
  return (
    <button className="record-action editor-view-action" type="button" aria-pressed={active} disabled={disabled} title={label} aria-label={`${label} view`} onClick={onClick}>
      <span className="editor-view-action-icon" style={{ "--editor-view-action-icon": `var(--asset-${icon})` } as CSSProperties} aria-hidden="true" />
    </button>
  );
};

const RawJsonBody = ({ editable, rawText, setRawText }: { editable: boolean; rawText: string; setRawText: (value: string) => void }) => {
  if (editable) {
    return (
      <textarea
        className="editor-rich-raw"
        value={rawText}
        spellCheck={false}
        onChange={(event) => setRawText(event.target.value)}
      />
    );
  }

  return (
    <div className="editor-raw-view__content" role="textbox" aria-label="Raw JSON" aria-readonly="true">
      {rawText.split("\n").map((line, index) => (
        <RawJsonLine key={`${index}-${line}`} line={line} />
      ))}
    </div>
  );
};

type EditorFormBodyProps = {
  draft: unknown;
  editable: boolean;
  fields: readonly EditorField[];
  savedValue: unknown;
  setDraftValue: (nextValue: unknown) => void;
};

const EditorFormBody = ({ draft, editable, fields, savedValue, setDraftValue }: EditorFormBodyProps) => {
  const draftObject = getObjectDraft(draft);
  const savedObject = getObjectDraft(savedValue);
  const effectiveFields = fields.length > 0 ? fields : getFieldsFromValue(draft);
  const secretOptions = getSecretSettingOptions();

  if (Array.isArray(draft)) {
    return (
      <div className="editor-rich-form">
        <RecursiveListEditor editable={editable} itemFields={effectiveFields} onAddItem={() => createEmptyRecord(effectiveFields, draft.length)} onChange={setDraftValue} savedValue={Array.isArray(savedValue) ? savedValue : []} secretOptions={secretOptions} value={draft} />
      </div>
    );
  }
  if (!draftObject) return <p className="map-empty-note">Edit view needs a JSON object or array.</p>;

  return (
    <div className="editor-rich-form">
      <EditorFieldsForm editable={editable} fields={effectiveFields} savedValue={savedObject ?? {}} value={draftObject} setValue={setDraftValue} />
    </div>
  );
};

const EditorFieldsForm = ({ editable, fields, savedValue, setValue, value }: { editable: boolean; fields: readonly EditorField[]; savedValue: Record<string, unknown>; setValue: (nextValue: Record<string, unknown>) => void; value: Record<string, unknown> }) => {
  const secretOptions = getSecretSettingOptions();

  return (
    <RecursiveDictEditor
      editable={editable}
      fields={fields}
      onChange={setValue}
      savedValue={savedValue}
      secretOptions={secretOptions}
      value={value}
    />
  );
};

const TableJsonBody = ({ value }: { value: unknown }) => {
  const rows = getTableRows(value);
  const columns = getTableColumns(rows);
  return (
    <div className="page-view-content page-table-view-content">
      <table className="editor-json-table">
        <thead>
          <tr>
            {columns.map((column) => <th key={column}>{column}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={getRowKey(row, rowIndex)}>
              {columns.map((column) => <td key={column}>{formatTableCell(row[column])}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const GraphJsonBody = ({ value }: { value: unknown }) => {
  return (
    <div className="page-view-content page-graph-view-content">
      <JsonGraphNode name="root" value={value} />
    </div>
  );
};

const JsonGraphNode = ({ name, value }: { name: string; value: unknown }) => {
  const objectValue = getObjectDraft(value);
  const children = Array.isArray(value)
    ? value.map((item, index) => [`${index}`, item] as const)
    : Object.entries(objectValue ?? {});

  return (
    <div className="editor-json-graph-node">
      <strong>{name}</strong>
      {children.length > 0 ? (
        <div className="editor-json-graph-children">
          {children.map(([childName, childValue]) => (
            <JsonGraphNode key={childName} name={childName} value={childValue} />
          ))}
        </div>
      ) : (
        <span>{formatTableCell(value)}</span>
      )}
    </div>
  );
};

const RawJsonLine = ({ line }: { line: string }) => {
  const match = line.match(/^(\s*)("[^"]+":\s)?(.*)$/);
  const indent = match?.[1] ?? "";
  const keyPrefix = match?.[2] ?? "";
  const lineValue = match?.[3] ?? line;

  return (
    <div className="editor-raw-view__line">
      {indent && <span className="editor-raw-view__indent">{indent}</span>}
      {keyPrefix && <span className="editor-raw-view__key">{keyPrefix}</span>}
      <span className="editor-raw-view__value">{lineValue || " "}</span>
    </div>
  );
};

const getViewSupport = (value: unknown) => {
  const structured = getStructuredValue(value) !== null;
  return {
    list: structured,
    table: getTableRows(value).length > 0,
    graph: structured
  };
};

const getTableRows = (value: unknown): Record<string, unknown>[] => {
  if (Array.isArray(value)) return value.map(getObjectDraft).filter((item): item is Record<string, unknown> => Boolean(item));
  const objectValue = getObjectDraft(value);
  return objectValue ? Object.entries(objectValue).map(([key, item]) => ({ key, value: item })) : [];
};

const getTableColumns = (rows: Record<string, unknown>[]) => {
  return Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
};

const getRowKey = (row: Record<string, unknown>, index: number) => {
  return typeof row.id === "string" || typeof row.id === "number" ? String(row.id) : String(index);
};

const getObjectDraft = (value: unknown) => {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : null;
};

const getStructuredValue = (value: unknown) => {
  if (Array.isArray(value)) return value;
  return getObjectDraft(value);
};

const getSavePayload = (value: unknown) => {
  if (Array.isArray(value)) return value;
  return getObjectDraft(value);
};

const createEmptyRecord = (fields: readonly EditorField[], index: number) => {
  const id = createRecordId();
  const record = fields.reduce<Record<string, unknown>>((next, field) => {
    next[field.key] = field.key === "id" ? id : field.control === "checkbox" ? false : "";
    return next;
  }, {});
  return Object.keys(record).length > 0 ? record : { id, name: "" };
};

const createRecordId = () => {
  return globalThis.crypto?.randomUUID?.() || `new-record-${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

const getFieldsFromValue = (value: unknown): readonly EditorField[] => {
  if (Array.isArray(value)) {
    const keys = Array.from(new Set(value.flatMap((item) => Object.keys(getObjectDraft(item) ?? {}))));
    return keys.map((key) => ({ key, label: key, multiline: true }));
  }

  return Object.keys(getObjectDraft(value) ?? {}).map((key) => ({ key, label: key, multiline: true }));
};

const formatTableCell = (value: unknown) => {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
};

const getEditorDirtyState = ({ draft, mode, rawText, savedValue }: { draft: unknown; mode: EditorJsonMode; rawText: string; savedValue: unknown }) => {
  if (mode === "raw") {
    try {
      return !areJsonValuesEqual(getSavePayload(JSON.parse(rawText)), savedValue);
    } catch {
      return rawText !== JSON.stringify(savedValue, null, 2);
    }
  }

  return !areJsonValuesEqual(draft, savedValue);
};

const areJsonValuesEqual = (left: unknown, right: unknown) => {
  return JSON.stringify(left) === JSON.stringify(right);
};

const getSecretSettingOptions = () => {
  const settings = loadWorkspaceSettings();
  return Array.isArray(settings)
    ? settings
      .filter((setting: any) => setting?.secret && typeof setting?.key === "string")
      .map((setting: any) => ({ key: setting.key, name: setting.name || setting.key }))
    : [];
};
