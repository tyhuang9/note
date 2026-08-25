import type { ReactNode } from "react";
import type {
  CanvasElement,
  ConnectorElement,
  ImageElement,
  InkElement,
  ShapeElement,
  TextElement,
} from "../model/elements";

type CanvasElementRendererProps = {
  element: CanvasElement;
  renderImage: (element: ImageElement) => ReactNode;
  renderInk?: (element: InkElement) => ReactNode;
  renderConnector?: (element: ConnectorElement) => ReactNode;
  renderShape?: (element: ShapeElement) => ReactNode;
  renderText: (element: TextElement) => ReactNode;
};

/** Central discriminated-union dispatch for scene elements. */
export function CanvasElementRenderer({
  element,
  renderImage,
  renderInk,
  renderConnector,
  renderShape,
  renderText,
}: CanvasElementRendererProps) {
  switch (element.type) {
    case "text":
      return renderText(element);
    case "image":
      return renderImage(element);
    case "ink":
      return renderInk?.(element) ?? (
        <div
          aria-hidden="true"
          data-canvas-element-id={element.id}
          data-canvas-element-type={element.type}
          hidden
        />
      );
    case "shape": return renderShape?.(element) ?? null;
    case "connector": return renderConnector?.(element) ?? null;
  }
}
