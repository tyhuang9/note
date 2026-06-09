import type { JSONContent } from "@tiptap/core";

export type Folder = {
  id: string;
  name: string;
};

export type Page = {
  id: string;
  folderId: string;
  title: string;
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

export type AppData = {
  folders: Folder[];
  pages: Page[];
  blocks: TextBlock[];
  isDarkMode?: boolean;
};
