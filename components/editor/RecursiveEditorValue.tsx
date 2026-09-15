import { Fragment, useState } from "react";
import { withBasePath } from "@/lib/basePath";
import type { EditorField } from "@/lib/editorSchema";
import { markdownToHtml } from "@/lib/markdown";
import styles from "./EditorArea.module.css";

type SecretOption = {
  key: string;
  name: string;
};

type RecursiveDictEditorProps = {
  editable: boolean;
  fields?: readonly EditorField[];
  onChange: (nextValue: Record<string, unknown>) => void;
  savedValue?: Record<string, unknown>;
  secretOptions?: readonly SecretOption[];
  value: Record<string, unknown>;
};

type RecursiveListEditorProps = {
  editable: boolean;
  onAddItem?: () => unknown;
  itemFields?: readonly EditorField[];
  onChange: (nextValue: unknown[]) => void;
  savedValue?: unknown[];
  secretOptions?: readonly SecretOption[];
  value: unknown[];
};

type RecursiveValueEditorProps = {
  context?: Record<string, unknown>;
  editable: boolean;
  field?: EditorField;
  onChange: (nextValue: unknown) => void;
  savedValue: unknown;
  secretOptions: readonly SecretOption[];
  value: unknown;
};

export const RecursiveDictEditor = ({ editable, fields = [], onChange, savedValue = {}, secretOptions = [], value }: RecursiveDictEditorProps) => {
  const rows = getDictRows(value, fields);

  return (
    <div className={styles.dict}>
      {rows.map(({ field, key }) => (
        <RecursiveDictRow
          field={field}
          editable={editable}
          key={key}
          name={key}
          onChange={(nextValue) => onChange({ ...value, [key]: nextValue })}
          savedValue={savedValue[key]}
          secretOptions={secretOptions}
          value={value[key]}
          valueContext={value}
        />
      ))}
    </div>
  );
};

export const RecursiveListEditor = ({ editable, itemFields = [], onAddItem, onChange, savedValue = [], secretOptions = [], value }: RecursiveListEditorProps) => {
  const addItem = () => {
    onChange([...value, onAddItem ? onAddItem() : createEmptyListItem(value, itemFields)]);
  };

  return (
    <div className={styles.list}>
      {value.map((item, index) => {
        const objectItem = getPlainObject(item);
        const savedItem = savedValue[index];
        const savedObjectItem = getPlainObject(savedItem);
        const updateItem = (nextItem: unknown) => onChange(value.map((currentItem, itemIndex) => itemIndex === index ? nextItem : currentItem));

        return (
          <RecursiveListItem
            editable={editable}
            itemFields={itemFields}
            key={getListItemKey(item, index)}
            label={`list:${index}`}
            objectItem={objectItem}
            onChange={updateItem}
            savedItem={savedItem}
            savedObjectItem={savedObjectItem}
            secretOptions={secretOptions}
            value={item}
          />
        );
      })}
      {editable && (
        <div className={styles.addItemRow}>
          <button className={styles.addItemButton} type="button" onClick={addItem}>
            Add Record
          </button>
        </div>
      )}
    </div>
  );
};

const RecursiveListItem = ({ editable, itemFields, label, objectItem, onChange, savedItem, savedObjectItem, secretOptions, value }: { editable: boolean; itemFields: readonly EditorField[]; label: string; objectItem: Record<string, unknown> | null; onChange: (nextValue: unknown) => void; savedItem: unknown; savedObjectItem: Record<string, unknown> | null; secretOptions: readonly SecretOption[]; value: unknown }) => {
  const [expanded, setExpanded] = useState(true);
  const isNested = objectItem || Array.isArray(value);

  return (
    <div className={styles.listItem}>
      {isNested ? (
        <Fragment>
          <button className={`${styles.key} ${styles.toggleKey}${objectItem ? ` ${styles.objectKey}` : ""}${Array.isArray(value) ? ` ${styles.listKey}` : ""}`} type="button" aria-expanded={expanded} onClick={() => setExpanded((current) => !current)}>
            {label}
          </button>
          {expanded && (
            <div className={styles.listItemBox}>
              {objectItem ? (
                <RecursiveDictEditor editable={editable} fields={itemFields} onChange={onChange} savedValue={savedObjectItem ?? {}} secretOptions={secretOptions} value={objectItem} />
              ) : (
                <RecursiveListEditor editable={editable} onChange={onChange} savedValue={Array.isArray(savedItem) ? savedItem : []} secretOptions={secretOptions} value={value as unknown[]} />
              )}
            </div>
          )}
        </Fragment>
      ) : (
        <Fragment>
          <span className={styles.key}>{label}</span>
          <RecursiveValueEditor editable={editable} onChange={onChange} savedValue={savedItem} secretOptions={secretOptions} value={value} />
        </Fragment>
      )}
    </div>
  );
};

const RecursiveDictRow = ({ editable, field, name, onChange, savedValue, secretOptions, value, valueContext }: { editable: boolean; field?: EditorField; name: string; onChange: (nextValue: unknown) => void; savedValue: unknown; secretOptions: readonly SecretOption[]; value: unknown; valueContext: Record<string, unknown> }) => {
  const label = field?.label || name;
  const objectValue = getPlainObject(value);
  const isNested = objectValue || Array.isArray(value);
  const [expanded, setExpanded] = useState(true);

  return (
    <div className={`${styles.row}${isNested ? ` ${styles.nested}` : ""}`}>
      <div className={styles.rowLine}>
        {isNested ? (
          <button className={`${styles.key} ${styles.toggleKey}${objectValue ? ` ${styles.objectKey}` : ""}${Array.isArray(value) ? ` ${styles.listKey}` : ""}`} type="button" aria-expanded={expanded} onClick={() => setExpanded((current) => !current)}>
            {label}
          </button>
        ) : (
          <span className={styles.key}>{label}</span>
        )}
        {objectValue && expanded && (
          <div className={styles.nestedBox}>
            <RecursiveDictEditor editable={editable} onChange={(nextValue) => onChange(nextValue)} savedValue={getPlainObject(savedValue) ?? {}} secretOptions={secretOptions} value={objectValue} />
          </div>
        )}
        {Array.isArray(value) && expanded && (
          <div className={styles.nestedBox}>
            <RecursiveListEditor editable={editable} onChange={(nextValue) => onChange(nextValue)} savedValue={Array.isArray(savedValue) ? savedValue : []} secretOptions={secretOptions} value={value} />
          </div>
        )}
        {!isNested && (
          <RecursiveValueEditor
            context={valueContext}
            editable={editable}
            field={field}
            onChange={onChange}
            savedValue={savedValue}
            secretOptions={secretOptions}
            value={value}
          />
        )}
      </div>
    </div>
  );
};

const RecursiveValueEditor = ({ context = {}, editable, field, onChange, savedValue, secretOptions, value }: RecursiveValueEditorProps) => {
  const objectValue = getPlainObject(value);
  const dirty = !areJsonValuesEqual(value, savedValue);
  const dirtyTitle = dirty ? getDirtyTitle(savedValue, value) : undefined;
  const dirtyClassName = dirty ? ` ${styles.dirty}` : "";
  const disabled = !editable || field?.readonly;
  const readonlyClassName = editable && field?.readonly ? ` ${styles.readonly}` : "";

  if (objectValue) {
    return <RecursiveDictEditor editable={editable} onChange={onChange} savedValue={getPlainObject(savedValue) ?? {}} secretOptions={secretOptions} value={objectValue} />;
  }

  if (Array.isArray(value)) {
    return <RecursiveListEditor editable={editable} onChange={onChange} savedValue={Array.isArray(savedValue) ? savedValue : []} secretOptions={secretOptions} value={value} />;
  }

  if (field?.rich) {
    const fieldValue = formatFieldValue(value);
    return (
      <Fragment>
        <div className={styles.richMenu}>
          <img src={withBasePath("/assets/code.svg")} alt="" aria-hidden="true" />
        </div>
        <textarea className={`${styles.textarea} ${styles.richTextarea}${readonlyClassName}${dirtyClassName}`} value={fieldValue} disabled={disabled} spellCheck={false} title={dirtyTitle} onChange={(event) => onChange(event.target.value)} />
        <div className={styles.richPreview} dangerouslySetInnerHTML={{ __html: markdownToHtml(fieldValue) }} />
      </Fragment>
    );
  }

  if (field?.control === "checkbox" || typeof value === "boolean") {
    return (
      <input className={`${styles.checkbox}${readonlyClassName}${dirtyClassName}`} type="checkbox" checked={Boolean(value)} disabled={disabled} title={dirtyTitle} onChange={(event) => onChange(event.target.checked)} />
    );
  }

  if (field?.control === "secretDropdown") {
    return (
      <select className={`${styles.select}${readonlyClassName}${dirtyClassName}`} value={formatFieldValue(value)} disabled={disabled} title={dirtyTitle} onChange={(event) => onChange(event.target.value)}>
        <option value="">Select secret</option>
        {secretOptions.map((option) => (
          <option key={option.key} value={option.key}>
            {option.name}
          </option>
        ))}
      </select>
    );
  }

  if (field?.control === "secretValue") {
    return (
      <input className={`${styles.input}${readonlyClassName}${dirtyClassName}`} type={context.secret ? "password" : "text"} value={formatFieldValue(value)} disabled={disabled} title={dirtyTitle} onChange={(event) => onChange(event.target.value)} />
    );
  }

  if (field?.multiline || field?.control === "textarea") {
    return (
      <textarea className={`${styles.textarea}${readonlyClassName}${dirtyClassName}`} value={formatFieldValue(value)} disabled={disabled} title={dirtyTitle} onChange={(event) => onChange(event.target.value)} />
    );
  }

  if (typeof value === "number") {
    return (
      <input className={`${styles.input}${readonlyClassName}${dirtyClassName}`} type="number" value={Number.isFinite(value) ? value : ""} disabled={disabled} title={dirtyTitle} onChange={(event) => onChange(event.target.value === "" ? "" : Number(event.target.value))} />
    );
  }

  return (
    <input className={`${styles.input}${readonlyClassName}${dirtyClassName}`} type="text" value={formatFieldValue(value)} disabled={disabled} title={dirtyTitle} onChange={(event) => onChange(event.target.value)} />
  );
};

const getDictRows = (value: Record<string, unknown>, fields: readonly EditorField[]) => {
  const fieldRows = fields.map((field) => ({ key: field.key, field }));
  const fieldKeys = new Set(fieldRows.map((row) => row.key));
  const extraRows = Object.keys(value)
    .filter((key) => !fieldKeys.has(key))
    .map((key) => ({ key, field: undefined }));
  return [...fieldRows, ...extraRows];
};

const getListItemKey = (value: unknown, index: number) => {
  const objectValue = getPlainObject(value);
  const id = objectValue?.id;
  return typeof id === "string" || typeof id === "number" ? String(id) : String(index);
};

const getPlainObject = (value: unknown) => {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : null;
};

const createEmptyListItem = (value: unknown[], itemFields: readonly EditorField[]) => {
  if (itemFields.length > 0) {
    return itemFields.reduce<Record<string, unknown>>((item, field) => {
      item[field.key] = field.control === "checkbox" ? false : "";
      return item;
    }, {});
  }

  const firstObject = getPlainObject(value.find((item) => getPlainObject(item)));
  if (firstObject) {
    return Object.keys(firstObject).reduce<Record<string, unknown>>((item, key) => {
      item[key] = "";
      return item;
    }, {});
  }

  return "";
};

const formatFieldValue = (value: unknown) => {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
};

const areJsonValuesEqual = (left: unknown, right: unknown) => {
  return JSON.stringify(left) === JSON.stringify(right);
};

const getDirtyTitle = (savedValue: unknown, value: unknown) => {
  return `${formatTitleValue(savedValue)} -> ${formatTitleValue(value)}`;
};

const formatTitleValue = (value: unknown) => {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
};
