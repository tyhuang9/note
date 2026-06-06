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
  isWidthManuallyResized?: boolean;
  imageData?: string;
  imageName?: string;
};

export type AppData = {
  folders: Folder[];
  pages: Page[];
  blocks: TextBlock[];
};
