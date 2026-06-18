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

export type AppSessionState = {
  selectedFolderId?: string;
  selectedPageId?: string;
  openPageTabIds?: string[];
  pageViewports?: Record<string, PersistedPageViewport>;
};

export type AppData = {
  folders: Folder[];
  pages: Page[];
  blocks: TextBlock[];
  isDarkMode?: boolean;
  sessionState?: AppSessionState;
};
