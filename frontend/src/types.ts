import type { CanvasElement, TextElement } from "./canvas/model/elements";
import type { DrawingPreferences } from "./canvas/model/drawingPreferences";
import type { TextPreferences } from "./canvas/model/textPreferences";

/** @deprecated Use TextElement. Kept only while legacy helper names are migrated. */
export type TextBlock = TextElement;

export type Folder = {
  id: string;
  name: string;
};

export type Page = {
  id: string;
  folderId: string;
  title: string;
  isBookmarked?: boolean;
};

export type PersistedPageViewport = {
  panOffset: {
    x: number;
    y: number;
  };
  zoomLevel: number;
};

export type AppSessionState = {
  drawingPreferences?: DrawingPreferences;
  textPreferences?: TextPreferences;
  isAssistantOpen?: boolean;
  isDrawingToolLocked?: boolean;
  isExplorerCollapsed?: boolean;
  selectedFolderId?: string;
  selectedPageId?: string;
  openPageTabIds?: string[];
  pageViewports?: Record<string, PersistedPageViewport>;
};

export type AppData = {
  elements: CanvasElement[];
  folders: Folder[];
  pages: Page[];
  isDarkMode?: boolean;
  sessionState?: AppSessionState;
};
