import { useEffect, useRef } from "react";

type InlineRenameProps = {
  ariaLabel: string;
  initialValue: string;
  onCancel: () => void;
  onCommit: (value: string) => void;
};

export function InlineRename({
  ariaLabel,
  initialValue,
  onCancel,
  onCommit,
}: InlineRenameProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const didCancel = useRef(false);
  const didCommit = useRef(false);

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  function commit(value: string) {
    if (didCancel.current || didCommit.current) {
      return;
    }

    didCommit.current = true;
    onCommit(value);
  }

  return (
    <input
      aria-label={ariaLabel}
      autoFocus
      className="inline-input"
      defaultValue={initialValue}
      onBlur={(event) => commit(event.currentTarget.value)}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          commit(event.currentTarget.value);
          event.currentTarget.blur();
        }

        if (event.key === "Escape") {
          didCancel.current = true;
          onCancel();
        }
      }}
      ref={inputRef}
    />
  );
}
