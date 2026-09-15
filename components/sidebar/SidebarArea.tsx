"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import Script from "next/script";
import type { FeatureName } from "@/lib/features";
import { DEFAULT_WORKSPACE_FEATURE_STATE, loadWorkspaceFeatureState, saveWorkspaceFeatureState } from "@/lib/workspaceFeatures";
import type { WorkspaceInvalidationScope, WorkspaceInvalidationState } from "@/lib/workspaceInvalidation";
import styles from "./Sidebar.module.css";
import { SidebarHeader } from "./SidebarHeader";
import { SidebarNavbar } from "./SidebarNavbar";
import { SidebarPanel } from "./SidebarPanel";

type SidebarAreaProps = {
  onOpenFile?: (entry: unknown) => void;
  onOpenAddressOnMap?: (address: unknown) => void;
  onOpenPage?: (id: string, label: string, value: unknown, options?: unknown) => void;
  onOpenSettings?: () => void;
  onInvalidateWorkspaceData?: (featureId: FeatureName, scopes: WorkspaceInvalidationScope | WorkspaceInvalidationScope[]) => void;
  onSelectAgentSession?: (session: { id: string }) => void;
  workspaceInvalidation?: WorkspaceInvalidationState;
};

const MAPBOX_SEARCH_SCRIPT = "https://api.mapbox.com/search-js/v1.5.0/web.js";

function moveFeature(featureOrder: FeatureName[], feature: FeatureName, targetFeature: FeatureName) {
  if (feature === targetFeature) return featureOrder;
  const nextOrder = featureOrder.filter((item) => item !== feature);
  const targetIndex = nextOrder.indexOf(targetFeature);
  if (targetIndex < 0) return featureOrder;
  nextOrder.splice(targetIndex, 0, feature);
  return nextOrder;
}

export const SidebarArea = ({ onOpenAddressOnMap, onOpenPage, onOpenSettings, onInvalidateWorkspaceData, onSelectAgentSession, workspaceInvalidation = {} }: SidebarAreaProps = {}) => {
  const [{ activeFeature, featureOrder }, setWorkspaceFeatureState] = useState(DEFAULT_WORKSPACE_FEATURE_STATE);
  const canSaveWorkspaceFeatureStateRef = useRef(false);
  const setActiveFeature = (feature: FeatureName) => {
    setWorkspaceFeatureState((state) => ({ ...state, activeFeature: feature }));
  };
  const setFeatureOrder = (feature: FeatureName, targetFeature: FeatureName) => {
    setWorkspaceFeatureState((state) => ({ ...state, featureOrder: moveFeature(state.featureOrder, feature, targetFeature) }));
  };

  useEffect(() => {
    setWorkspaceFeatureState(loadWorkspaceFeatureState());
    canSaveWorkspaceFeatureStateRef.current = true;
  }, []);

  useEffect(() => {
    if (!canSaveWorkspaceFeatureStateRef.current) return;
    saveWorkspaceFeatureState({ activeFeature, featureOrder });
  }, [activeFeature, featureOrder]);

  return (
    <Fragment>
      <Script id="search-js" src={MAPBOX_SEARCH_SCRIPT} strategy="afterInteractive" />
      <aside className={styles.shell} aria-label="Sidebar">
        <SidebarHeader />
        <div className={styles.body}>
          <SidebarNavbar
            activeFeature={activeFeature}
            featureOrder={featureOrder}
            setActiveFeature={setActiveFeature}
            onMoveFeature={setFeatureOrder}
            onOpenSettings={onOpenSettings}
          />
          <SidebarPanel
            activeFeature={activeFeature}
            featureOrder={featureOrder}
            onOpenAddressOnMap={onOpenAddressOnMap}
            onOpenPage={onOpenPage}
            onOpenSettings={onOpenSettings}
            onInvalidateWorkspaceData={onInvalidateWorkspaceData}
            onSelectAgentSession={onSelectAgentSession}
            workspaceInvalidation={workspaceInvalidation}
          />
        </div>
      </aside>
    </Fragment>
  );
};
