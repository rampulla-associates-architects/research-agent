export type EditorNavTab = {
  closeable: boolean;
  dirty?: boolean;
  id: string;
  label: string;
};

type EditorNavbarProps = {
  activeTabId: string;
  onActivateTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  tabs: EditorNavTab[];
};

export function EditorNavbar({ activeTabId, onActivateTab, onCloseTab, tabs }: EditorNavbarProps) {
  return (
    <div className="editor-tab-bar" id="editorTabBar">
      {tabs.map((tab) => (
        <div
          className={`editor-tab${tab.id === activeTabId ? " is-active" : ""}`}
          key={tab.id}
          role="button"
          tabIndex={0}
          onClick={() => onActivateTab(tab.id)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onActivateTab(tab.id);
            }
          }}
        >
          <span>{tab.label}</span>
          {tab.dirty && <span className="editor-tab-dirty-dot" aria-label="Unsaved changes" />}
          {tab.closeable && (
            <button
              className="editor-tab-close"
              type="button"
              aria-label={`Close ${tab.label}`}
              onClick={(event) => {
                event.stopPropagation();
                onCloseTab(tab.id);
              }}
            />
          )}
        </div>
      ))}
    </div>
  );
}
