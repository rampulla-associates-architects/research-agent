import { useEffect } from "react";
import type { FeatureName } from "@/lib/features";
import { getFeatureLabel } from "@/lib/features";
import type { WorkspaceInvalidationScope, WorkspaceInvalidationState } from "@/lib/workspaceInvalidation";
import styles from "./Sidebar.module.css";
import { SidebarPanelItem } from "./SidebarPanelItem";

type SidebarPanelProps = {
  activeFeature: FeatureName;
  featureOrder: FeatureName[];
  onOpenAddressOnMap?: (address: unknown) => void;
  onOpenPage?: (id: string, label: string, value: unknown, options?: unknown) => void;
  onOpenSettings?: () => void;
  onInvalidateWorkspaceData?: (featureId: FeatureName, scopes: WorkspaceInvalidationScope | WorkspaceInvalidationScope[]) => void;
  onSelectAgentSession?: (session: { id: string }) => void;
  workspaceInvalidation?: WorkspaceInvalidationState;
};

export const SidebarPanel = ({ activeFeature, featureOrder, onOpenAddressOnMap, onOpenPage, onOpenSettings, onInvalidateWorkspaceData, onSelectAgentSession, workspaceInvalidation = {} }: SidebarPanelProps) => {
  useEffect(() => {
    if (activeFeature === "settings") onOpenSettings?.();
  }, [activeFeature, onOpenSettings]);

  return (
    <div className={styles.panelShell}>
      <section
        className={`workspace-tab${activeFeature === "workspace" ? " is-active" : ""}`}
        id="workspaceTab"
        data-tab-panel
        hidden={activeFeature !== "workspace"}
      >
        <div className="section-title-row">
          <label className={styles.workspaceSelector}>
            <select defaultValue={featureOrder[0]} aria-label="Workspace">
              {featureOrder.map((featureId) => (
                <option key={featureId} value={featureId}>{getFeatureLabel(featureId)}</option>
              ))}
            </select>
          </label>
        </div>
      </section>
      {featureOrder.map((featureId) => (
        <SidebarPanelItem
          key={featureId}
          active={activeFeature === featureId}
          featureId={featureId}
          onOpenAddressOnMap={onOpenAddressOnMap}
          onOpenPage={onOpenPage}
          onInvalidateWorkspaceData={onInvalidateWorkspaceData}
          onSelectAgentSession={onSelectAgentSession}
          workspaceInvalidation={workspaceInvalidation}
        />
      ))}
    </div>
  );
};
