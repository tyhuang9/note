import { autoUpdate, computePosition, flip, offset, shift, size } from "@floating-ui/dom";
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import Suggestion, {
  exitSuggestion,
  type SuggestionKeyDownProps,
  type SuggestionProps,
} from "@tiptap/suggestion";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SlashCommandMenu } from "../components/SlashCommandMenu";
import {
  getSlashCommandItems,
  runSlashCommand,
  type SlashCommandItem,
} from "./slashCommands";

let slashMenuId = 0;
let slashExtensionId = 0;

type SlashSuggestionProps = SuggestionProps<SlashCommandItem, SlashCommandItem>;

function canShowSlashCommands({
  range,
  state,
}: {
  range: { from: number; to: number };
  state: SlashSuggestionProps["editor"]["state"];
}) {
  const $from = state.doc.resolve(range.from);

  if (
    $from.depth !== 1 ||
    ($from.parent.type.name !== "paragraph" &&
      $from.parent.type.name !== "heading")
  ) {
    return false;
  }

  const previousCharacter = $from.parent.textBetween(
    Math.max(0, $from.parentOffset - 1),
    $from.parentOffset,
    "\n",
    "\ufffc",
  );

  if ($from.parentOffset > 0 && !/\s/u.test(previousCharacter)) {
    return false;
  }

  const forbiddenMarkNames = ["link", "code"];
  const activeMarks = state.storedMarks ?? $from.marks();

  return forbiddenMarkNames.every((markName) => {
    const markType = state.schema.marks[markName];

    return !markType || (
      !activeMarks.some((mark) => mark.type === markType) &&
      !state.doc.rangeHasMark(range.from, range.to, markType)
    );
  });
}

function createSlashCommandRenderer(pluginKey: PluginKey) {
  let activeIndex = 0;
  let cleanupAutoUpdate: (() => void) | null = null;
  let floatingElement: HTMLDivElement | null = null;
  let frameId: number | null = null;
  let props: SlashSuggestionProps | null = null;
  let reactRoot: Root | null = null;
  let restoredEditorAttributes: Record<string, string | null> | null = null;
  const menuId = `slash-command-menu-${++slashMenuId}`;

  function updateEditorAria() {
    if (!props) {
      return;
    }

    const editorElement = props.editor.view.dom;

    editorElement.setAttribute("aria-controls", menuId);
    editorElement.setAttribute("aria-expanded", "true");
    editorElement.setAttribute("aria-autocomplete", "list");
    editorElement.setAttribute("aria-haspopup", "listbox");
    editorElement.removeAttribute("aria-multiline");
    editorElement.setAttribute("role", "combobox");

    if (props.items[activeIndex]) {
      editorElement.setAttribute(
        "aria-activedescendant",
        `${menuId}-option-${activeIndex}`,
      );
    } else {
      editorElement.removeAttribute("aria-activedescendant");
    }
  }

  function renderMenu() {
    if (!props || !reactRoot) {
      return;
    }

    updateEditorAria();
    reactRoot.render(
      createElement(SlashCommandMenu, {
        activeIndex,
        items: props.items,
        menuId,
        onActiveIndexChange: (nextIndex) => {
          activeIndex = nextIndex;
          renderMenu();
        },
        onSelect: (item) => props?.command(item),
      }),
    );
  }

  function updatePosition() {
    if (!props?.clientRect || !floatingElement) {
      return;
    }

    const positionElement = floatingElement;
    const positionProps = props;

    const reference = {
      contextElement: positionProps.editor.view.dom,
      getBoundingClientRect: () =>
        positionProps.clientRect?.() ?? new DOMRect(0, 0, 0, 0),
    };

    void computePosition(reference, positionElement, {
      middleware: [
        offset(8),
        flip({ padding: 8 }),
        shift({ padding: 8 }),
        size({
          padding: 8,
          apply({ availableHeight, elements }) {
            elements.floating.style.maxHeight = `${Math.max(
              0,
              Math.min(360, availableHeight),
            )}px`;
          },
        }),
      ],
      placement: "bottom-start",
      strategy: "fixed",
    }).then(({ x, y }) => {
      if (floatingElement !== positionElement || props !== positionProps) {
        return;
      }

      const viewportPadding = 8;
      const maxLeft = Math.max(
        viewportPadding,
        window.innerWidth - positionElement.offsetWidth - viewportPadding,
      );
      const maxTop = Math.max(
        viewportPadding,
        window.innerHeight - positionElement.offsetHeight - viewportPadding,
      );

      Object.assign(positionElement.style, {
        left: `${Math.min(Math.max(x, viewportPadding), maxLeft)}px`,
        top: `${Math.min(Math.max(y, viewportPadding), maxTop)}px`,
        visibility: "visible",
      });
    }).catch(() => {
      if (floatingElement === positionElement && props === positionProps) {
        exitSuggestion(positionProps.editor.view, pluginKey);
      }
    });
  }

  function restoreEditorAria() {
    if (!props || !restoredEditorAttributes) {
      return;
    }

    const editorElement = props.editor.view.dom;

    Object.entries(restoredEditorAttributes).forEach(([name, value]) => {
      if (value === null) {
        editorElement.removeAttribute(name);
      } else {
        editorElement.setAttribute(name, value);
      }
    });
    restoredEditorAttributes = null;
  }

  function cleanup() {
    if (frameId !== null) {
      window.cancelAnimationFrame(frameId);
      frameId = null;
    }

    cleanupAutoUpdate?.();
    cleanupAutoUpdate = null;
    restoreEditorAria();
    reactRoot?.unmount();
    reactRoot = null;
    floatingElement?.remove();
    floatingElement = null;
    props = null;
    activeIndex = 0;
  }

  function moveActiveIndex(offsetAmount: number) {
    if (!props?.items.length) {
      return false;
    }

    activeIndex =
      (activeIndex + offsetAmount + props.items.length) % props.items.length;
    renderMenu();
    return true;
  }

  function handleKeyDown({ event }: SuggestionKeyDownProps) {
    if (event.isComposing) {
      return false;
    }

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      return moveActiveIndex(event.key === "ArrowDown" ? 1 : -1);
    }

    if ((event.key === "Home" || event.key === "End") && props?.items.length) {
      event.preventDefault();
      activeIndex = event.key === "Home" ? 0 : props.items.length - 1;
      renderMenu();
      return true;
    }

    if (event.key === "Enter" && props?.items.length) {
      event.preventDefault();
      props.command(props.items[activeIndex] ?? props.items[0]);
      return true;
    }

    if (event.key === "Tab" && props) {
      exitSuggestion(props.editor.view, pluginKey);
      return false;
    }

    return false;
  }

  return {
    onExit: cleanup,
    onKeyDown: handleKeyDown,
    onStart(nextProps: SlashSuggestionProps) {
      cleanup();
      props = nextProps;
      activeIndex = 0;
      const editorElement = props.editor.view.dom;

      restoredEditorAttributes = {
        "aria-activedescendant": editorElement.getAttribute("aria-activedescendant"),
        "aria-autocomplete": editorElement.getAttribute("aria-autocomplete"),
        "aria-controls": editorElement.getAttribute("aria-controls"),
        "aria-expanded": editorElement.getAttribute("aria-expanded"),
        "aria-haspopup": editorElement.getAttribute("aria-haspopup"),
        "aria-multiline": editorElement.getAttribute("aria-multiline"),
        role: editorElement.getAttribute("role"),
      };
      floatingElement = document.createElement("div");
      floatingElement.className = "slash-command-popup";
      floatingElement.classList.toggle(
        "is-dark",
        editorElement.closest(".app-shell.is-dark") !== null,
      );
      floatingElement.style.position = "fixed";
      floatingElement.style.visibility = "hidden";
      floatingElement.style.zIndex = "100";
      document.body.appendChild(floatingElement);
      reactRoot = createRoot(floatingElement);
      renderMenu();

      frameId = window.requestAnimationFrame(() => {
        frameId = null;

        if (!props?.clientRect || !floatingElement) {
          return;
        }

        const reference = {
          contextElement: props.editor.view.dom,
          getBoundingClientRect: () =>
            props?.clientRect?.() ?? new DOMRect(0, 0, 0, 0),
        };

        cleanupAutoUpdate = autoUpdate(reference, floatingElement, updatePosition);
        updatePosition();
        // React commits the menu content after the first layout pass. Re-run
        // once after that commit so flip/shift can measure the real popup box
        // at viewport edges (especially when the canvas is zoomed).
        frameId = window.requestAnimationFrame(() => {
          frameId = null;
          updatePosition();
        });
      });
    },
    onUpdate(nextProps: SlashSuggestionProps) {
      props = nextProps;
      activeIndex = 0;
      renderMenu();
      updatePosition();
    },
  };
}

export function createSlashCommandExtension(editorKey: string) {
  const instanceId = ++slashExtensionId;
  const normalizedEditorKey = editorKey.replace(/[^a-z0-9_-]/giu, "-");
  const pluginKey = new PluginKey(
    `slashCommand-${normalizedEditorKey}-${instanceId}`,
  );
  const compositionGuardKey = new PluginKey(
    `slashCommandCompositionGuard-${normalizedEditorKey}-${instanceId}`,
  );

  return Extension.create({
    name: "slashCommand",

    addProseMirrorPlugins() {
      return [
        new Plugin({
          key: compositionGuardKey,
          props: {
            handleDOMEvents: {
              keydown: (view, event) =>
                event.isComposing || view.composing,
            },
          },
        }),
        Suggestion<SlashCommandItem, SlashCommandItem>({
          allow: ({ range, state }) => canShowSlashCommands({ range, state }),
          allowSpaces: true,
          allowedPrefixes: null,
          char: "/",
          command: ({ editor, props, range }) => {
            runSlashCommand(editor, range, props);
          },
          decorationClass: "slash-command-trigger",
          editor: this.editor,
          items: ({ query }) => getSlashCommandItems(query),
          pluginKey,
          render: () => createSlashCommandRenderer(pluginKey),
        }),
      ];
    },
  });
}
