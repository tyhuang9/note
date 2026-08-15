import type { JSONContent } from "@tiptap/core";

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

export type TextBlock = {
  id: string;
  pageId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  content: string;
  richContent?: JSONContent;
  isWidthManuallyResized?: boolean;
  imageData?: string;
  imageName?: string;
};

export type PersistedPageViewport = {
  panOffset: {
    x: number;
    y: number;
  };
  zoomLevel: number;
};

export type TextFontFamily =
  | "system-ui"
  | "Arial"
  | "Georgia"
  | "Times New Roman"
  | "Courier New";

export type TextFontSize = "12px" | "14px" | "16px" | "18px" | "24px" | "32px";

export type TextFormatDefaults = {
  bold: boolean;
  italic: boolean;
  strike: boolean;
  underline: boolean;
  bulletList: boolean;
  orderedList: boolean;
  blockquote: boolean;
  code: boolean;
  fontFamily: TextFontFamily;
  fontSize: TextFontSize;
};

export type AppSessionState = {
  isAssistantOpen?: boolean;
  isExplorerCollapsed?: boolean;
  selectedFolderId?: string;
  selectedPageId?: string;
  openPageTabIds?: string[];
  pageViewports?: Record<string, PersistedPageViewport>;
  textFormatDefaults?: Partial<TextFormatDefaults>;
};

export type AppData = {
  folders: Folder[];
  pages: Page[];
  blocks: TextBlock[];
  isDarkMode?: boolean;
  sessionState?: AppSessionState;
};
