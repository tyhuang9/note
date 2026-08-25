import type { ComponentType } from "react";

export type WorkbenchIconName =
  | "adjustments-horizontal"
  | "archive-box"
  | "arrows-up-down"
  | "bookmark"
  | "bold"
  | "check"
  | "chevron-down"
  | "chevron-right"
  | "chevron-up"
  | "code-bracket"
  | "document-plus"
  | "document-text"
  | "eye"
  | "eye-slash"
  | "folder"
  | "folder-plus"
  | "heading-1"
  | "heading-2"
  | "heading-3"
  | "italic"
  | "list-bullet"
  | "magnifying-glass"
  | "minus"
  | "moon"
  | "numbered-list"
  | "panel"
  | "pencil-square"
  | "plus"
  | "quote"
  | "rectangle-stack"
  | "sparkles"
  | "squares-2x2"
  | "star"
  | "strikethrough"
  | "sun"
  | "trash"
  | "underline"
  | "x-mark";

export interface WorkbenchIconProps {
  readonly name: WorkbenchIconName;
}

export type WorkbenchIconComponent = ComponentType<
  Readonly<WorkbenchIconProps>
>;
