import { config } from "../../../package.json";

const ANNOTATION_ASK_ENABLED_KEY = `${config.prefsPrefix}.annotationAskEnabled`;

export function isAnnotationAskEnabled(): boolean {
  const value = Zotero.Prefs.get(ANNOTATION_ASK_ENABLED_KEY, true);
  return value === true || `${value || ""}`.toLowerCase() === "true";
}

export function setAnnotationAskEnabled(enabled: boolean): void {
  Zotero.Prefs.set(ANNOTATION_ASK_ENABLED_KEY, Boolean(enabled), true);
}
