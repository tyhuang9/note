import type { Editor, Range } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import type { Mark, Node as ProseMirrorNode } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import type { WorkbenchIconName } from "../components/workbench/icons";

export type SlashCommandGroup = "Text" | "Lists" | "Blocks";

type SlashCommandKind =
  | "paragraph"
  | "heading1"
  | "heading2"
  | "heading3"
  | "bulletList"
  | "orderedList"
  | "blockquote"
  | "codeBlock"
  | "horizontalRule";

export type SlashCommandItem = {
  aliases: readonly string[];
  description: string;
  group: SlashCommandGroup;
  hint: string;
  icon: WorkbenchIconName;
  id: SlashCommandKind;
  label: string;
};

export const slashCommands: readonly SlashCommandItem[] = [
  {
    aliases: ["text", "paragraph", "plain", "body", "p"],
    description: "Continue with plain text",
    group: "Text",
    hint: "",
    icon: "document-text",
    id: "paragraph",
    label: "Text",
  },
  {
    aliases: ["h1", "heading1", "heading one", "title"],
    description: "Large section heading",
    group: "Text",
    hint: "#",
    icon: "heading-1",
    id: "heading1",
    label: "Heading 1",
  },
  {
    aliases: ["h2", "heading2", "heading two", "subtitle"],
    description: "Medium section heading",
    group: "Text",
    hint: "##",
    icon: "heading-2",
    id: "heading2",
    label: "Heading 2",
  },
  {
    aliases: ["h3", "heading3", "heading three", "subheading"],
    description: "Small section heading",
    group: "Text",
    hint: "###",
    icon: "heading-3",
    id: "heading3",
    label: "Heading 3",
  },
  {
    aliases: ["bullet", "bullets", "bulleted", "unordered", "ul", "list"],
    description: "Create a bulleted list",
    group: "Lists",
    hint: "-",
    icon: "list-bullet",
    id: "bulletList",
    label: "Bulleted list",
  },
  {
    aliases: ["number", "numbered", "ordered", "ol", "list"],
    description: "Create a numbered list",
    group: "Lists",
    hint: "1.",
    icon: "numbered-list",
    id: "orderedList",
    label: "Numbered list",
  },
  {
    aliases: ["quote", "blockquote", "citation"],
    description: "Capture a quotation",
    group: "Blocks",
    hint: ">",
    icon: "quote",
    id: "blockquote",
    label: "Quote",
  },
  {
    aliases: ["code", "codeblock", "snippet", "pre", "preformatted"],
    description: "Insert a code block",
    group: "Blocks",
    hint: "```",
    icon: "code-bracket",
    id: "codeBlock",
    label: "Code block",
  },
  {
    aliases: ["divider", "separator", "horizontal", "rule", "hr", "line"],
    description: "Separate sections with a line",
    group: "Blocks",
    hint: "---",
    icon: "minus",
    id: "horizontalRule",
    label: "Divider",
  },
];

function normalizeQuery(value: string) {
  return value.trim().toLocaleLowerCase();
}

function getMatchScore(command: SlashCommandItem, query: string) {
  const label = command.label.toLocaleLowerCase();
  const aliases = command.aliases.map((alias) => alias.toLocaleLowerCase());

  if (label === query) {
    return 0;
  }

  if (aliases.includes(query)) {
    return 1;
  }

  if (label.startsWith(query)) {
    return 2;
  }

  if (aliases.some((alias) => alias.startsWith(query))) {
    return 3;
  }

  if (label.includes(query)) {
    return 4;
  }

  if (aliases.some((alias) => alias.includes(query))) {
    return 5;
  }

  return null;
}

export function getSlashCommandItems(query: string) {
  const normalizedQuery = normalizeQuery(query);

  if (!normalizedQuery) {
    return [...slashCommands];
  }

  return slashCommands
    .map((command, index) => ({
      command,
      index,
      score: getMatchScore(command, normalizedQuery),
    }))
    .filter(
      (match): match is typeof match & { score: number } =>
        match.score !== null,
    )
    .sort((first, second) => first.score - second.score || first.index - second.index)
    .map(({ command }) => command);
}

function createCommandNode(
  command: SlashCommandItem,
  editor: Editor,
): { cursorOffset: number; node: ProseMirrorNode } {
  const { nodes } = editor.schema;
  const paragraph = nodes.paragraph;

  switch (command.id) {
    case "paragraph":
      return { cursorOffset: 1, node: paragraph.create() };
    case "heading1":
      return { cursorOffset: 1, node: nodes.heading.create({ level: 1 }) };
    case "heading2":
      return { cursorOffset: 1, node: nodes.heading.create({ level: 2 }) };
    case "heading3":
      return { cursorOffset: 1, node: nodes.heading.create({ level: 3 }) };
    case "bulletList":
      return {
        cursorOffset: 3,
        node: nodes.bulletList.create(
          null,
          nodes.listItem.create(null, paragraph.create()),
        ),
      };
    case "orderedList":
      return {
        cursorOffset: 3,
        node: nodes.orderedList.create(
          null,
          nodes.listItem.create(null, paragraph.create()),
        ),
      };
    case "blockquote":
      return {
        cursorOffset: 2,
        node: nodes.blockquote.create(null, paragraph.create()),
      };
    case "codeBlock":
      return { cursorOffset: 1, node: nodes.codeBlock.create() };
    case "horizontalRule":
      return { cursorOffset: 0, node: nodes.horizontalRule.create() };
  }
}

function getStoredMarksForCommand(
  command: SlashCommandItem,
  marks: readonly Mark[],
) {
  if (command.id === "codeBlock") {
    return [];
  }

  if (!command.id.startsWith("heading")) {
    return [...marks];
  }

  return marks.map((mark) => {
    if (mark.type.name !== "textStyle" || mark.attrs.fontSize == null) {
      return mark;
    }

    return mark.type.create({
      ...mark.attrs,
      fontSize: null,
    });
  });
}

export function runSlashCommand(
  editor: Editor,
  range: Range,
  command: SlashCommandItem,
) {
  const { state, view } = editor;
  const $from = state.doc.resolve(range.from);
  const $to = state.doc.resolve(range.to);

  if ($from.depth !== 1 || !$from.sameParent($to)) {
    return false;
  }

  const sourceNode = $from.parent;
  const sourceStart = $from.before(1);
  const sourceEnd = $from.after(1);
  const slashOffset = $from.parentOffset;
  const queryEndOffset = $to.parentOffset;
  const textBeforeSlash = sourceNode.textBetween(0, slashOffset, "\n", "\ufffc");
  const trailingSpaceLength = textBeforeSlash.match(/[\t \u00a0]+$/)?.[0].length ?? 0;
  const prefixEndOffset = slashOffset - trailingSpaceLength;
  const prefixContent = sourceNode.content.cut(0, prefixEndOffset);
  const suffixContent = sourceNode.content.cut(queryEndOffset);
  const prefixNode = prefixContent.size
    ? sourceNode.type.create(sourceNode.attrs, prefixContent, sourceNode.marks)
    : null;
  const { cursorOffset, node: commandNode } = createCommandNode(command, editor);
  const replacement: ProseMirrorNode[] = [];

  if (prefixNode) {
    replacement.push(prefixNode);
  }

  const commandNodeOffset = replacement.reduce(
    (offset, node) => offset + node.nodeSize,
    0,
  );

  replacement.push(commandNode);

  if (suffixContent.size) {
    replacement.push(editor.schema.nodes.paragraph.create(null, suffixContent));
  } else if (command.id === "horizontalRule") {
    replacement.push(editor.schema.nodes.paragraph.create());
  }

  const tr = state.tr.replaceWith(sourceStart, sourceEnd, replacement);
  const commandStart = sourceStart + commandNodeOffset;
  const cursorPosition = command.id === "horizontalRule"
    ? commandStart + commandNode.nodeSize + 1
    : commandStart + cursorOffset;
  const nextSelection = TextSelection.create(tr.doc, cursorPosition);
  const inheritedMarks = state.storedMarks ?? $from.marks();
  const storedMarks = getStoredMarksForCommand(command, inheritedMarks).filter(
    (mark) => nextSelection.$from.parent.type.allowsMarkType(mark.type),
  );

  tr.setSelection(nextSelection)
    .setStoredMarks(storedMarks)
    .scrollIntoView();
  closeHistory(tr);
  view.dispatch(tr);
  view.focus();
  return true;
}
