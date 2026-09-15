import type { ReactNode } from "react";

interface EditorActionsMenuProps {
  left?: ReactNode;
  onViewClick?: () => void;
  right?: ReactNode;
  viewIconSrc?: string;
  viewLabel?: string;
}

export const EditorActionsMenu = ({ left, onViewClick, right, viewIconSrc, viewLabel }: EditorActionsMenuProps) => {
  return (
    <div className="editor-actions-menu">
      <div className="editor-actions-menu-actions">
        {viewIconSrc && onViewClick && (
          <button className="editor-actions-menu-view" type="button" title={viewLabel} aria-label={viewLabel} onClick={onViewClick}>
            <img src={viewIconSrc} alt="" aria-hidden="true" />
          </button>
        )}
        {viewIconSrc && !onViewClick && (
          <span className="editor-actions-menu-view" title={viewLabel} aria-label={viewLabel}>
            <img src={viewIconSrc} alt="" aria-hidden="true" />
          </span>
        )}
        {left}
      </div>
      <div className="editor-actions-menu-actions editor-actions-menu-actions-right">
        {right}
      </div>
    </div>
  );
};
