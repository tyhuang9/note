import { describe, expect, it } from "vitest";
import { movePagesToFolder } from "../../src/pageOrganization";

interface TestPage {
  id: string;
  folderId: string;
  title: string;
}

function page(id: string, folderId: string): TestPage {
  return { folderId, id, title: id };
}

describe("page organization", () => {
  it("moves a top-level page into a folder", () => {
    const result = movePagesToFolder(
      [page("root", ""), page("inside", "folder")],
      ["root"],
      "folder",
    );

    expect(result?.pages).toEqual([
      page("inside", "folder"),
      page("root", "folder"),
    ]);
    expect(result?.movedPages.map(({ id }) => id)).toEqual(["root"]);
  });

  it("moves a page out of a folder when the top level is empty", () => {
    const result = movePagesToFolder(
      [page("inside", "folder")],
      ["inside"],
      "",
    );

    expect(result?.pages).toEqual([page("inside", "")]);
  });

  it("preserves explorer order for a multi-page move", () => {
    const result = movePagesToFolder(
      [
        page("first", "source"),
        page("middle", "other"),
        page("second", "source"),
        page("existing", "target"),
      ],
      ["second", "first"],
      "target",
    );

    expect(result?.pages.map(({ id }) => id)).toEqual([
      "middle",
      "existing",
      "first",
      "second",
    ]);
  });

  it("does nothing when every dragged page is already in the target folder", () => {
    expect(
      movePagesToFolder(
        [page("one", "folder"), page("two", "folder")],
        ["one", "two"],
        "folder",
      ),
    ).toBeNull();
  });

  it("ignores missing and protected pages without removing them", () => {
    const pages = [page("movable", "source"), page("protected", "templates")];
    const result = movePagesToFolder(
      pages,
      ["missing", "protected", "movable"],
      "target",
      (candidate) => candidate.folderId !== "templates",
    );

    expect(result?.pages).toEqual([
      page("protected", "templates"),
      page("movable", "target"),
    ]);
  });
});
