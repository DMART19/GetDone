export interface PwaUpdateState {
  updateAvailable: boolean;
  online: boolean;
  hasUnsavedOwnerInput: boolean;
  strongApprovalInProgress: boolean;
}

export type PwaUpdateAction = "none" | "defer" | "offer-reload";

export function decidePwaUpdateAction(state: PwaUpdateState): PwaUpdateAction {
  if (!state.updateAvailable) return "none";
  if (!state.online || state.hasUnsavedOwnerInput || state.strongApprovalInProgress) {
    return "defer";
  }
  return "offer-reload";
}
