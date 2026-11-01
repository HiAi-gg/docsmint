/** Host-owned authorization; no global mutable active-workspace state. */
export interface McpWorkspaceDescriptor {
  id: string;
  name: string;
  slug: string;
  entireWorkspace: boolean;
  categoryIds: string[];
}

export interface McpWorkspaceRouting {
  /** Return only the intersection of live membership and this connection grant. */
  listWorkspaces(): Promise<McpWorkspaceDescriptor[]>;
  /** Reject unless the host has already bound this call to the selected workspace. */
  assertSelection(workspaceId: string): Promise<void>;
}
