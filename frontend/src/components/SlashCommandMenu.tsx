import { useEffect, useRef, useState } from "react";
import {
  Code2,
  FileText,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  Minus,
  Quote,
  type LucideIcon,
} from "lucide-react";
import type {
  SlashCommandGroup,
  SlashCommandIcon,
  SlashCommandItem,
} from "../editor/slashCommands";

const slashIcons: Record<SlashCommandIcon, LucideIcon> = {
  bulletList: List,
  codeBlock: Code2,
  heading1: Heading1,
  heading2: Heading2,
  heading3: Heading3,
  minus: Minus,
  orderedList: ListOrdered,
  quote: Quote,
  text: FileText,
};

type SlashCommandMenuProps = {
  activeIndex: number;
  items: readonly SlashCommandItem[];
  menuId: string;
  onActiveIndexChange: (index: number) => void;
  onSelect: (item: SlashCommandItem) => void;
};

export function SlashCommandMenu({
  activeIndex,
  items,
  menuId,
  onActiveIndexChange,
  onSelect,
}: SlashCommandMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [hasMoreBelow, setHasMoreBelow] = useState(false);
  const visibleGroups = items.reduce<SlashCommandGroup[]>((groups, item) => {
    if (!groups.includes(item.group)) {
      groups.push(item.group);
    }

    return groups;
  }, []);

  function updateScrollCue() {
    const menuElement = menuRef.current;

    setHasMoreBelow(
      Boolean(
        menuElement &&
          menuElement.scrollTop + menuElement.clientHeight <
            menuElement.scrollHeight - 1,
      ),
    );
  }

  useEffect(() => {
    const frameId = window.requestAnimationFrame(updateScrollCue);

    return () => window.cancelAnimationFrame(frameId);
  }, [items]);

  useEffect(() => {
    document.getElementById(`${menuId}-option-${activeIndex}`)?.scrollIntoView({
      block: "nearest",
    });
  }, [activeIndex, menuId]);

  return (
    <>
      <div
        aria-label="Slash commands"
        className={`slash-command-menu ${hasMoreBelow ? "has-more-below" : ""}`}
        data-has-more-below={hasMoreBelow || undefined}
        id={menuId}
        onScroll={updateScrollCue}
        ref={menuRef}
        role="listbox"
      >
        {items.length === 0 ? (
          <div
            aria-disabled="true"
            aria-live="polite"
            aria-selected="false"
            className="slash-command-empty"
            role="option"
          >
            No commands found
          </div>
        ) : null}
        {visibleGroups.map((group) => {
          const groupItems = items
            .map((item, index) => ({ index, item }))
            .filter(({ item }) => item.group === group);

          if (groupItems.length === 0) {
            return null;
          }

          const groupId = `${menuId}-${group.toLocaleLowerCase()}-label`;

          return (
            <div aria-labelledby={groupId} key={group} role="group">
              <div className="slash-command-group-label" id={groupId}>
                {group}
              </div>
              {groupItems.map(({ index, item }) => {
                const Icon = slashIcons[item.icon];

                return (
                  <button
                    aria-selected={index === activeIndex}
                    className="slash-command-item"
                    id={`${menuId}-option-${index}`}
                    key={item.id}
                    onClick={() => onSelect(item)}
                    onPointerDown={(event) => event.preventDefault()}
                    onPointerEnter={() => {
                      if (index !== activeIndex) {
                        onActiveIndexChange(index);
                      }
                    }}
                    role="option"
                    tabIndex={-1}
                    type="button"
                  >
                    <span className="slash-command-icon">
                      <Icon aria-hidden="true" size={20} />
                    </span>
                    <span className="slash-command-copy">
                      <span className="slash-command-label">{item.label}</span>
                      <span className="slash-command-description">
                        {item.description}
                      </span>
                    </span>
                    {item.hint ? (
                      <span aria-hidden="true" className="slash-command-hint">
                        {item.hint}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
      <div aria-hidden="true" className="slash-command-footer">
        <span>Close menu</span>
        <span className="slash-command-footer-key">Esc</span>
      </div>
    </>
  );
}
