export interface OrganizablePage {
  id: string;
  folderId: string;
}

export function insertPagesAfterLastPageInFolder<T extends OrganizablePage>(
  pages: readonly T[],
  folderId: string,
  insertedPages: readonly T[],
) {
  let insertIndex = pages.length;

  for (let index = pages.length - 1; index >= 0; index -= 1) {
    if (pages[index].folderId === folderId) {
      insertIndex = index + 1;
      break;
    }
  }

  return [
    ...pages.slice(0, insertIndex),
    ...insertedPages,
    ...pages.slice(insertIndex),
  ];
}

export function movePagesToFolder<T extends OrganizablePage>(
  pages: readonly T[],
  draggedPageIds: readonly string[],
  targetFolderId: string,
  canMove: (page: T) => boolean = () => true,
) {
  const draggedPageIdSet = new Set(draggedPageIds);

  if (draggedPageIdSet.size === 0) {
    return null;
  }

  const draggedPages = pages.filter(
    (page) => draggedPageIdSet.has(page.id) && canMove(page),
  );

  if (
    draggedPages.length === 0 ||
    draggedPages.every((page) => page.folderId === targetFolderId)
  ) {
    return null;
  }

  const movedPageIdSet = new Set(draggedPages.map((page) => page.id));
  const stationaryPages = pages.filter((page) => !movedPageIdSet.has(page.id));
  const movedPages = draggedPages.map((page) => ({
    ...page,
    folderId: targetFolderId,
  }));

  return {
    movedPages,
    pages: insertPagesAfterLastPageInFolder(
      stationaryPages,
      targetFolderId,
      movedPages,
    ),
  };
}
