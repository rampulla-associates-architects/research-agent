"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import type { Layout } from "react-resizable-panels";
import { AgentArea } from "@/components/agent/AgentArea";
import { EditorArea } from "@/components/editor/EditorArea";
import { SidebarArea } from "@/components/sidebar/SidebarArea";
import { loadWorkspaceSettings, saveWorkspaceSettings, workspaceSettingsEditorFields } from "@/lib/workspaceSettings";
import { DEFAULT_PANEL_LAYOUT, loadWorkspacePanelLayout, saveWorkspacePanelLayout } from "@/lib/workspaceLayouts";
import { EMPTY_WORKSPACE_INVALIDATION, bumpWorkspaceInvalidation, type WorkspaceInvalidationScope } from "@/lib/workspaceInvalidation";
import type { FeatureName } from "@/lib/features";

type AgentSessionSelection = {
  id: string;
};

export function Application() {
  const [panelLayout, setPanelLayout] = useState(() => DEFAULT_PANEL_LAYOUT as Layout);
  const [workspaceInvalidation, setWorkspaceInvalidation] = useState(EMPTY_WORKSPACE_INVALIDATION);
  const canSavePanelLayoutRef = useRef(false);
  const onPanelLayoutChanged = useCallback((panelLayout: Layout) => {
    if (!canSavePanelLayoutRef.current) return;
    saveWorkspacePanelLayout(panelLayout);
  }, []);

  useEffect(() => {
    setPanelLayout(loadWorkspacePanelLayout() as Layout);
    canSavePanelLayoutRef.current = true;
  }, []);

  const openFileRef = useRef<((entry: unknown) => void) | null>(null);
  const onOpenFile = useCallback((entry: unknown) => openFileRef.current?.(entry), []);
  const openAddressOnMapRef = useRef<((address: unknown) => void) | null>(null);
  const onOpenAddressOnMap = useCallback((address: unknown) => openAddressOnMapRef.current?.(address), []);

  const openPageRef = useRef<((id: string, label: string, value: unknown, options?: unknown) => void) | null>(null);
  const onOpenPage = useCallback((id: string, label: string, value: unknown, options?: unknown) => {
    openPageRef.current?.(id, label, value, options);
  }, []);
  const invalidateWorkspaceData = useCallback((featureId: FeatureName, scopes: WorkspaceInvalidationScope | WorkspaceInvalidationScope[]) => {
    setWorkspaceInvalidation((state) => bumpWorkspaceInvalidation(state, featureId, scopes));
  }, []);
  const onOpenSettings = useCallback(() => {
    openPageRef.current?.("settings", "Settings", loadWorkspaceSettings(), {
      featureId: "settings",
      fields: workspaceSettingsEditorFields,
      onSave: (settings: unknown) => {
        saveWorkspaceSettings(settings);
        invalidateWorkspaceData("settings", ["info", "detail"]);
      },
      reload: loadWorkspaceSettings,
      target: "item"
    });
  }, [invalidateWorkspaceData]);

  const suggestToolRef = useRef<((name: string) => void) | null>(null);
  const [selectedAgentSession, setSelectedAgentSession] = useState<AgentSessionSelection | null>(null);

  return (
    <div className="app-shell">
      <Group
        orientation="horizontal"
        className="workbench-panels"
        defaultLayout={panelLayout}
        key={JSON.stringify(panelLayout)}
        onLayoutChanged={onPanelLayoutChanged}
      >
        <Panel id="sidebar" minSize="8" collapsible>
          <SidebarArea
            onOpenFile={onOpenFile}
            onOpenPage={onOpenPage}
            onOpenSettings={onOpenSettings}
            onOpenAddressOnMap={onOpenAddressOnMap}
            onInvalidateWorkspaceData={invalidateWorkspaceData}
            onSelectAgentSession={setSelectedAgentSession}
            workspaceInvalidation={workspaceInvalidation}
          />
        </Panel>
        <Separator className="workbench-resize-handle" />
        <Panel id="editor" minSize="20">
          <EditorArea
            openAddressOnMapRef={openAddressOnMapRef}
            openFileRef={openFileRef}
            openPageRef={openPageRef}
            suggestToolRef={suggestToolRef}
            workspaceInvalidation={workspaceInvalidation}
          />
        </Panel>
        <Separator className="workbench-resize-handle" />
        <Panel id="agent" minSize="8" collapsible>
          <AgentArea onInvalidateWorkspaceData={invalidateWorkspaceData} selectedSession={selectedAgentSession} />
        </Panel>
      </Group>
    </div>
  );
}
