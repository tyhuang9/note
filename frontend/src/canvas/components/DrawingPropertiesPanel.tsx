import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Activity, ArrowDown, ArrowUp, Ban, ChevronsDown, ChevronsUp, Circle, Minus, Palette, Square, Waves } from "lucide-react";
import type { CanvasColor, RoughStyle, TextBackgroundMode } from "../model/elements";
import type {
  DrawingProperty,
  DrawingPropertyUpdate,
  DrawingPropertyValues,
  PropertyValue,
} from "../model/drawingPreferences";
import type { LayerAction } from "../model/layerOrdering";

type DrawingPropertiesPanelProps = {
  contextLabel: string;
  isBackgroundModeDisabled: boolean;
  isCompactOpen: boolean;
  isInert?: boolean;
  isSelection: boolean;
  onCancelPreview: () => void;
  onLayerAction: (action: LayerAction) => void;
  onPreview: (update: DrawingPropertyUpdate) => void;
  onUpdate: (update: DrawingPropertyUpdate) => void;
  strokeWidthPresets: readonly number[];
  supports: (property: DrawingProperty) => boolean;
  values: DrawingPropertyValues;
};

const strokeColors = ["#1b1b1f", "#e03131", "#2f9e44", "#1971c2", "#f08c00"];
const backgroundColors = ["#ffc9c9", "#ffec99", "#b2f2bb", "#a5d8ff", "#d0bfff"];

export function DrawingPropertiesPanel({
  contextLabel,
  isBackgroundModeDisabled,
  isCompactOpen,
  isInert = false,
  isSelection,
  onCancelPreview,
  onLayerAction,
  onPreview,
  onUpdate,
  strokeWidthPresets,
  supports,
  values,
}: DrawingPropertiesPanelProps) {
  const [opacityDraft, setOpacityDraft] = useState(() => percent(values.opacity));
  const isAdjustingOpacity = useRef(false);
  const hasOpacityPreviewChange = useRef(false);
  const opacityDescriptionId = useId();
  const cancelOpacityRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (!isAdjustingOpacity.current) setOpacityDraft(percent(values.opacity));
  }, [values.opacity]);

  function previewOpacity(next: number) {
    hasOpacityPreviewChange.current = true;
    setOpacityDraft(next);
    onPreview({ property: "opacity", value: next / 100 });
  }

  function commitOpacity(next = opacityDraft) {
    if (!isAdjustingOpacity.current) return;
    isAdjustingOpacity.current = false;
    if (!hasOpacityPreviewChange.current) return;
    hasOpacityPreviewChange.current = false;
    setOpacityDraft(next);
    onUpdate({ property: "opacity", value: next / 100 });
  }

  function beginOpacityAdjustment() {
    isAdjustingOpacity.current = true;
    hasOpacityPreviewChange.current = false;
  }

  function cancelOpacity() {
    isAdjustingOpacity.current = false;
    hasOpacityPreviewChange.current = false;
    setOpacityDraft(percent(values.opacity));
    onCancelPreview();
  }

  cancelOpacityRef.current = cancelOpacity;

  useEffect(() => {
    const cancelForWindowBlur = () => cancelOpacityRef.current();
    window.addEventListener("blur", cancelForWindowBlur);
    return () => {
      window.removeEventListener("blur", cancelForWindowBlur);
      cancelOpacityRef.current();
    };
  }, []);

  return (
    <aside
      aria-label="Drawing properties"
      className={`drawing-properties-panel ${isCompactOpen ? "is-compact-open" : ""}`}
      id="drawing-properties-panel"
      inert={isInert ? true : undefined}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <header className="drawing-properties-header">
        <h2>Properties</h2>
        <span>{contextLabel}</span>
      </header>

      {supports("strokeColor") ? (
        <PropertySection label="Stroke">
          <ColorPicker
            colors={strokeColors}
            label="Stroke color"
            onChange={(value) => onUpdate({ property: "strokeColor", value })}
            value={values.strokeColor}
          />
        </PropertySection>
      ) : null}

      {supports("backgroundColor") ? (
        <PropertySection label="Background">
          <ColorPicker
            allowNone
            colors={backgroundColors}
            label="Background color"
            onChange={(value) => onUpdate({ property: "backgroundColor", value })}
            value={values.backgroundColor}
          />
        </PropertySection>
      ) : null}

      {supports("backgroundMode") ? (
        <PropertySection label="Text background">
          <TextBackgroundModeChoices
            disabled={isBackgroundModeDisabled}
            onChange={(value) => onUpdate({ property: "backgroundMode", value })}
            value={values.backgroundMode}
          />
        </PropertySection>
      ) : null}

      {supports("strokeWidth") ? (
        <PropertySection label="Stroke width">
          <ChoiceGroup label="Stroke width" mixed={values.strokeWidth.kind === "mixed"}>
            {strokeWidthPresets.map((width, index) => (
              <ChoiceButton
                active={isValue(values.strokeWidth, width)}
                key={width}
                label={`${index === 0 ? "Thin" : index === 1 ? "Medium" : "Thick"} stroke (${width}px)`}
                mixed={values.strokeWidth.kind === "mixed"}
                onClick={() => onUpdate({ property: "strokeWidth", value: width })}
              >
                <Minus aria-hidden="true" size={21} strokeWidth={width} />
              </ChoiceButton>
            ))}
          </ChoiceGroup>
        </PropertySection>
      ) : null}

      {supports("strokeStyle") ? (
        <PropertySection label="Stroke style">
          <ChoiceGroup label="Stroke style" mixed={values.strokeStyle.kind === "mixed"}>
            {(["solid", "dashed", "dotted"] as const).map((style) => (
              <ChoiceButton
                active={isValue(values.strokeStyle, style)}
                key={style}
                label={`${capitalize(style)} stroke`}
                mixed={values.strokeStyle.kind === "mixed"}
                onClick={() => onUpdate({ property: "strokeStyle", value: style })}
                text={style === "solid" ? "Solid" : style === "dashed" ? "Dash" : "Dot"}
              />
            ))}
          </ChoiceGroup>
        </PropertySection>
      ) : null}

      {supports("roughness") ? (
        <PropertySection label="Sloppiness">
          <ChoiceGroup label="Sloppiness" mixed={values.roughness.kind === "mixed"}>
            {([
              { value: 0, label: "Architect", Icon: Minus },
              { value: 1.2, label: "Artist", Icon: Waves },
              { value: 2.2, label: "Cartoonist", Icon: Activity },
            ] as const).map(({ value, label, Icon }) => (
              <ChoiceButton
                active={isValue(values.roughness, value)}
                key={label}
                label={label}
                mixed={values.roughness.kind === "mixed"}
                onClick={() => onUpdate({ property: "roughness", value })}
              >
                <Icon aria-hidden="true" size={19} />
              </ChoiceButton>
            ))}
          </ChoiceGroup>
        </PropertySection>
      ) : null}

      {supports("roundness") ? (
        <PropertySection label="Edges">
          <ChoiceGroup label="Rectangle edges" mixed={values.roundness.kind === "mixed"}>
            <ChoiceButton active={isValue(values.roundness, 0)} label="Subtle corners" mixed={values.roundness.kind === "mixed"} onClick={() => onUpdate({ property: "roundness", value: 0 })}>
              <Square aria-hidden="true" size={19} />
            </ChoiceButton>
            <ChoiceButton active={isValue(values.roundness, 0.18)} label="Rounded corners" mixed={values.roundness.kind === "mixed"} onClick={() => onUpdate({ property: "roundness", value: 0.18 })}>
              <Circle aria-hidden="true" size={19} />
            </ChoiceButton>
          </ChoiceGroup>
        </PropertySection>
      ) : null}

      {supports("opacity") ? (
        <PropertySection label="Opacity">
          <div className="drawing-opacity-row">
            <input
              aria-describedby={values.opacity.kind === "mixed" ? opacityDescriptionId : undefined}
              aria-label="Opacity"
              aria-valuetext={values.opacity.kind === "mixed" && !isAdjustingOpacity.current
                ? "Mixed opacity values"
                : `${opacityDraft} percent`}
              max="100"
              min="0"
              onBlur={(event) => commitOpacity(Number(event.currentTarget.value))}
              onChange={(event) => previewOpacity(Number(event.currentTarget.value))}
              onKeyDown={beginOpacityAdjustment}
              onKeyUp={(event) => commitOpacity(Number(event.currentTarget.value))}
              onLostPointerCapture={(event) => commitOpacity(Number(event.currentTarget.value))}
              onPointerCancel={cancelOpacity}
              onPointerDown={beginOpacityAdjustment}
              onPointerUp={(event) => commitOpacity(Number(event.currentTarget.value))}
              step="1"
              type="range"
              value={opacityDraft}
            />
            <output aria-live="polite">{values.opacity.kind === "mixed" && !isAdjustingOpacity.current ? "Mixed" : `${opacityDraft}%`}</output>
            {values.opacity.kind === "mixed" ? (
              <span className="sr-only" id={opacityDescriptionId}>
                Selected elements have different opacity values. Adjusting this slider applies one value to every unlocked compatible element.
              </span>
            ) : null}
          </div>
        </PropertySection>
      ) : null}

      {isSelection ? (
        <PropertySection label="Layers">
          <ChoiceGroup label="Layer order">
            <ChoiceButton label="Bring to front" onClick={() => onLayerAction("bring-to-front")}><ChevronsUp aria-hidden="true" size={19} /></ChoiceButton>
            <ChoiceButton label="Bring forward" onClick={() => onLayerAction("bring-forward")}><ArrowUp aria-hidden="true" size={19} /></ChoiceButton>
            <ChoiceButton label="Send backward" onClick={() => onLayerAction("send-backward")}><ArrowDown aria-hidden="true" size={19} /></ChoiceButton>
            <ChoiceButton label="Send to back" onClick={() => onLayerAction("send-to-back")}><ChevronsDown aria-hidden="true" size={19} /></ChoiceButton>
          </ChoiceGroup>
        </PropertySection>
      ) : null}
    </aside>
  );
}

function PropertySection({ children, label }: { children: ReactNode; label: string }) {
  return <section className="drawing-property-section"><h3>{label}</h3>{children}</section>;
}

function ChoiceGroup({ children, label, mixed = false }: { children: ReactNode; label: string; mixed?: boolean }) {
  const mixedLabelId = useId();
  return (
    <div
      aria-describedby={mixed ? mixedLabelId : undefined}
      aria-label={label}
      className="drawing-choice-group"
      role="group"
    >
      {children}
      {mixed ? <span className="drawing-mixed-label" id={mixedLabelId}>Mixed</span> : null}
    </div>
  );
}

function ChoiceButton({ active = false, children, label, mixed = false, onClick, text }: {
  active?: boolean;
  children?: ReactNode;
  label: string;
  mixed?: boolean;
  onClick: () => void;
  text?: string;
}) {
  return (
    <button
      aria-label={label}
      aria-pressed={active}
      className={mixed ? "has-mixed-value" : undefined}
      data-tooltip={label}
      onClick={onClick}
      title={label}
      type="button"
    >
      {children}
      {text ? <span>{text}</span> : null}
    </button>
  );
}

function TextBackgroundModeChoices({ disabled, onChange, value }: {
  disabled: boolean;
  onChange: (value: TextBackgroundMode) => void;
  value: PropertyValue<TextBackgroundMode>;
}) {
  const mixedLabelId = useId();
  const lockedReasonId = useId();
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const modes = ["surface", "transparent"] as const;
  const selectedIndex = value.kind === "value" ? modes.indexOf(value.value) : 0;

  function moveRadioFocus(index: number) {
    if (disabled) return;
    const nextIndex = (index + modes.length) % modes.length;
    const nextMode = modes[nextIndex];
    onChange(nextMode);
    optionRefs.current[nextIndex]?.focus();
  }
  return (
    <div
      aria-describedby={[
        value.kind === "mixed" ? mixedLabelId : null,
        disabled ? lockedReasonId : null,
      ].filter(Boolean).join(" ") || undefined}
      aria-disabled={disabled || undefined}
      aria-label="Text background"
      className="drawing-choice-group"
      role="radiogroup"
    >
      {modes.map((mode, index) => (
        <button
          aria-checked={value.kind === "value" && value.value === mode}
          aria-label={`${mode === "surface" ? "Surface" : "Transparent"} text background`}
          className={value.kind === "mixed" ? "has-mixed-value" : undefined}
          data-tooltip={mode === "surface" ? "Surface" : "Transparent"}
          disabled={disabled}
          key={mode}
          onClick={() => onChange(mode)}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
              event.preventDefault();
              moveRadioFocus(index - 1);
            }
            if (event.key === "ArrowRight" || event.key === "ArrowDown") {
              event.preventDefault();
              moveRadioFocus(index + 1);
            }
          }}
          ref={(element) => { optionRefs.current[index] = element; }}
          role="radio"
          tabIndex={disabled ? -1 : index === selectedIndex ? 0 : -1}
          title={mode === "surface" ? "Surface" : "Transparent"}
          type="button"
        >
          <span>{mode === "surface" ? "Surface" : "Transparent"}</span>
        </button>
      ))}
      {value.kind === "mixed" ? <span className="drawing-mixed-label" id={mixedLabelId}>Mixed</span> : null}
      {disabled ? <span className="sr-only" id={lockedReasonId}>All selected text boxes are locked.</span> : null}
    </div>
  );
}

function ColorPicker<T extends CanvasColor | null>({ allowNone = false, colors, label, onChange, value }: {
  allowNone?: boolean;
  colors: readonly string[];
  label: string;
  onChange: (value: T) => void;
  value: PropertyValue<T>;
}) {
  const selectedColor = value.kind === "value" ? colorString(value.value) : null;
  return (
    <div aria-label={`${label}${value.kind === "mixed" ? ", mixed values" : ""}`} className="drawing-color-picker" role="group">
      {allowNone ? (
        <button aria-label="Transparent" aria-pressed={value.kind === "value" && value.value === null} onClick={() => onChange(null as T)} title="Transparent" type="button">
          <Ban aria-hidden="true" size={17} />
        </button>
      ) : null}
      {colors.map((color) => (
        <button
          aria-label={`${label} ${color}`}
          aria-pressed={selectedColor?.toLowerCase() === color.toLowerCase()}
          className="drawing-color-swatch"
          key={color}
          onClick={() => onChange({ kind: "fixed", value: color } as T)}
          style={{ "--swatch-color": color } as CSSProperties}
          title={color}
          type="button"
        />
      ))}
      <label className="drawing-custom-color" title={`Custom ${label.toLowerCase()}`}>
        <Palette aria-hidden="true" size={17} />
        <span className="sr-only">Custom {label.toLowerCase()}</span>
        <input
          aria-label={`Custom ${label.toLowerCase()}`}
          onChange={(event) => onChange({ kind: "fixed", value: event.currentTarget.value } as T)}
          type="color"
          value={selectedColor ?? "#845ef7"}
        />
      </label>
      {value.kind === "mixed" ? <span className="drawing-mixed-label">Mixed</span> : null}
    </div>
  );
}

function colorString(color: CanvasColor | null) {
  if (!color) return null;
  return color.kind === "fixed" ? color.value : color.token === "foreground" ? "#1b1b1f" : "#868e96";
}

function percent(value: PropertyValue<number>) {
  return value.kind === "value" ? Math.round(value.value * 100) : 100;
}

function isValue<T>(value: PropertyValue<T>, expected: T) {
  return value.kind === "value" && value.value === expected;
}

function capitalize(value: RoughStyle["strokeStyle"]) {
  return value[0].toUpperCase() + value.slice(1);
}
