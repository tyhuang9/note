import type {
  NotesContextBlock,
  NotesContextInput,
  NotesContextPage,
  NotesContextSnapshot,
} from "../aiTypes";

const ROOT_FOLDER_ID = "";
const ROOT_FOLDER_NAME = "Root";
const UNKNOWN_FOLDER_NAME = "Unknown folder";
const UNTITLED_PAGE_TITLE = "Untitled page";
const EMPTY_BLOCK_CONTENT = "(empty text block)";

const MAX_PROMPT_SUMMARY_LENGTH = 6000;
const MAX_BLOCK_SNIPPET_LENGTH = 280;
const MAX_ACTIVE_BLOCKS_IN_PROMPT = 24;
const MAX_SELECTED_BLOCKS_IN_PROMPT = 12;
const MAX_FOLDERS_IN_PROMPT = 20;
const MAX_PAGES_IN_PROMPT = 40;
const MAX_METADATA_LABEL_LENGTH = 90;

type Folder = NotesContextInput["data"]["folders"][number];
type Page = NotesContextInput["data"]["pages"][number];
type TextBlock = NotesContextInput["data"]["blocks"][number];

export function buildNotesContext(
  input: NotesContextInput,
): NotesContextSnapshot {
  const { data, selectedBlockIds, selectedPageId } = input;
  const folderNamesById = buildFolderNamesById(data.folders);
  const pagesById = buildPagesById(data.pages);
  const activePageData = pagesById.get(selectedPageId);
  const activePage = activePageData
    ? toContextPage(activePageData, folderNamesById)
    : undefined;
  const selectedBlockIdSet = new Set(selectedBlockIds);
  const activePageBlocks = data.blocks
    .filter((block) => block.pageId === selectedPageId)
    .sort(compareBlocksByPosition)
    .slice(0, MAX_ACTIVE_BLOCKS_IN_PROMPT)
    .map(toContextBlock);
  const selectedBlocks = data.blocks
    .filter((block) => selectedBlockIdSet.has(block.id))
    .sort(compareBlocksByPosition)
    .slice(0, MAX_SELECTED_BLOCKS_IN_PROMPT)
    .map(toContextBlock);

  return {
    activePage,
    activePageBlocks,
    appData: {
      folders: data.folders.slice(0, MAX_FOLDERS_IN_PROMPT).map((folder) => ({ ...folder })),
      pages: data.pages.slice(0, MAX_PAGES_IN_PROMPT).map((page) => ({ ...page })),
    },
    promptSummary: buildPromptSummary({
      activePage,
      activePageBlocks,
      data,
      folderNamesById,
      pagesById,
      selectedBlocks,
    }),
    selectedBlocks,
  };
}

function buildFolderNamesById(folders: Folder[]) {
  const folderNamesById = new Map<string, string>();

  for (const folder of folders) {
    folderNamesById.set(folder.id, folder.name);
  }

  return folderNamesById;
}

function buildPagesById(pages: Page[]) {
  const pagesById = new Map<string, Page>();

  for (const page of pages) {
    pagesById.set(page.id, page);
  }

  return pagesById;
}

function toContextPage(
  page: Page,
  folderNamesById: Map<string, string>,
): NotesContextPage {
  return {
    folderName: getFolderName(page.folderId, folderNamesById),
    id: page.id,
    isActive: true,
    title: page.title,
  };
}

function toContextBlock(block: TextBlock): NotesContextBlock {
  return {
    content: truncateText(block.content, MAX_BLOCK_SNIPPET_LENGTH),
    height: block.height,
    id: block.id,
    pageId: block.pageId,
    width: block.width,
    x: block.x,
    y: block.y,
  };
}

function compareBlocksByPosition(firstBlock: TextBlock, secondBlock: TextBlock) {
  return (
    firstBlock.y - secondBlock.y ||
    firstBlock.x - secondBlock.x ||
    firstBlock.id.localeCompare(secondBlock.id)
  );
}

function buildPromptSummary({
  activePage,
  activePageBlocks,
  data,
  folderNamesById,
  pagesById,
  selectedBlocks,
}: {
  activePage: NotesContextPage | undefined;
  activePageBlocks: NotesContextBlock[];
  data: NotesContextInput["data"];
  folderNamesById: Map<string, string>;
  pagesById: Map<string, Page>;
  selectedBlocks: NotesContextBlock[];
}) {
  const lines: string[] = [
    "Notes context",
    `Workspace: ${data.folders.length} folders, ${data.pages.length} pages, ${data.blocks.length} text blocks.`,
    activePage
      ? `Active page: ${formatMetadataLabel(activePage.title || UNTITLED_PAGE_TITLE)} in ${formatMetadataLabel(activePage.folderName)}.`
      : "Active page: none selected.",
    `Selected blocks: ${selectedBlocks.length}.`,
    "",
  ];

  appendBlockSection({
    blockLimit: MAX_SELECTED_BLOCKS_IN_PROMPT,
    blocks: selectedBlocks,
    lines,
    pagesById,
    sectionTitle: "Selected block snippets",
  });

  appendBlockSection({
    blockLimit: MAX_ACTIVE_BLOCKS_IN_PROMPT,
    blocks: activePageBlocks,
    lines,
    pagesById,
    sectionTitle: "Active page block snippets, top-to-bottom",
  });

  appendFolderMetadata(lines, data, folderNamesById);
  appendPageMetadata(lines, data, folderNamesById);

  return truncateText(lines.join("\n").trim(), MAX_PROMPT_SUMMARY_LENGTH);
}

function appendBlockSection({
  blockLimit,
  blocks,
  lines,
  pagesById,
  sectionTitle,
}: {
  blockLimit: number;
  blocks: NotesContextBlock[];
  lines: string[];
  pagesById: Map<string, Page>;
  sectionTitle: string;
}) {
  if (blocks.length === 0) {
    lines.push(`${sectionTitle}: none.`, "");
    return;
  }

  const shownBlocks = blocks.slice(0, blockLimit);

  lines.push(`${sectionTitle}: showing ${shownBlocks.length} of ${blocks.length}.`);

  for (const block of shownBlocks) {
    lines.push(formatBlockLine(block, pagesById));
  }

  if (blocks.length > shownBlocks.length) {
    lines.push(`... ${blocks.length - shownBlocks.length} more blocks omitted.`);
  }

  lines.push("");
}

function appendFolderMetadata(
  lines: string[],
  data: NotesContextInput["data"],
  folderNamesById: Map<string, string>,
) {
  const shownFolders = data.folders.slice(0, MAX_FOLDERS_IN_PROMPT);
  const pageCountsByFolderId = buildPageCountsByFolderId(data.pages);

  lines.push(
    `Folder metadata: showing ${shownFolders.length} of ${data.folders.length}.`,
  );

  if (data.pages.some((page) => page.folderId === ROOT_FOLDER_ID)) {
    const rootPageCount = pageCountsByFolderId.get(ROOT_FOLDER_ID) ?? 0;

    lines.push(`- ${ROOT_FOLDER_NAME}: ${rootPageCount} pages`);
  }

  for (const folder of shownFolders) {
    const pageCount = pageCountsByFolderId.get(folder.id) ?? 0;

    lines.push(`- ${formatMetadataLabel(folder.name)}: ${pageCount} pages`);
  }

  if (data.folders.length > shownFolders.length) {
    lines.push(`... ${data.folders.length - shownFolders.length} more folders omitted.`);
  }

  if (folderNamesById.size === 0 && shownFolders.length === 0) {
    lines.push("- none");
  }

  lines.push("");
}

function appendPageMetadata(
  lines: string[],
  data: NotesContextInput["data"],
  folderNamesById: Map<string, string>,
) {
  const shownPages = data.pages.slice(0, MAX_PAGES_IN_PROMPT);
  const blockCountsByPageId = buildBlockCountsByPageId(data.blocks);

  lines.push(`Page metadata: showing ${shownPages.length} of ${data.pages.length}.`);

  for (const page of shownPages) {
    const blockCount = blockCountsByPageId.get(page.id) ?? 0;
    const folderName = getFolderName(page.folderId, folderNamesById);
    const bookmarkText = page.isBookmarked ? ", bookmarked" : "";

    lines.push(
      `- ${formatMetadataLabel(page.title || UNTITLED_PAGE_TITLE)} (${formatMetadataLabel(folderName)}): ${blockCount} blocks${bookmarkText}`,
    );
  }

  if (data.pages.length > shownPages.length) {
    lines.push(`... ${data.pages.length - shownPages.length} more pages omitted.`);
  }

  if (shownPages.length === 0) {
    lines.push("- none");
  }
}

function buildPageCountsByFolderId(pages: Page[]) {
  const pageCountsByFolderId = new Map<string, number>();

  for (const page of pages) {
    pageCountsByFolderId.set(
      page.folderId,
      (pageCountsByFolderId.get(page.folderId) ?? 0) + 1,
    );
  }

  return pageCountsByFolderId;
}

function buildBlockCountsByPageId(blocks: TextBlock[]) {
  const blockCountsByPageId = new Map<string, number>();

  for (const block of blocks) {
    blockCountsByPageId.set(
      block.pageId,
      (blockCountsByPageId.get(block.pageId) ?? 0) + 1,
    );
  }

  return blockCountsByPageId;
}

function formatBlockLine(block: NotesContextBlock, pagesById: Map<string, Page>) {
  const page = pagesById.get(block.pageId);
  const pageTitle = page?.title || UNTITLED_PAGE_TITLE;
  const position = `x=${formatNumber(block.x)}, y=${formatNumber(block.y)}`;
  const size = `${formatNumber(block.width)}x${formatNumber(block.height)}`;
  const content = formatBlockSnippet(block.content);

  return `- ${formatMetadataLabel(pageTitle)} block ${block.id} (${position}, ${size}): ${content}`;
}

function formatBlockSnippet(content: string) {
  const normalizedContent = normalizeInlineText(content);

  if (!normalizedContent) {
    return EMPTY_BLOCK_CONTENT;
  }

  return truncateText(normalizedContent, MAX_BLOCK_SNIPPET_LENGTH);
}

function getFolderName(
  folderId: string,
  folderNamesById: Map<string, string>,
) {
  if (folderId === ROOT_FOLDER_ID) {
    return ROOT_FOLDER_NAME;
  }

  return folderNamesById.get(folderId) ?? UNKNOWN_FOLDER_NAME;
}

function formatMetadataLabel(value: string) {
  return truncateText(normalizeInlineText(value), MAX_METADATA_LABEL_LENGTH);
}

function normalizeInlineText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function truncateText(value: string, maxLength: number) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function formatNumber(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}
