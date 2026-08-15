import type { ReactNode } from "react";
import type {
  CanvasElement,
  ImageElement,
  TextElement,
} from "../model/elements";

type CanvasElementRendererProps = {
  element: CanvasElement;
  renderImage: (element: ImageElement) => ReactNode;
  renderText: (element: TextElement) => ReactNode;
};

/** Central discriminated-union dispatch for scene elements. */
export function CanvasElementRenderer({
  element,
  renderImage,
  renderText,
}: CanvasElementRendererProps) {
  switch (element.type) {
    case "text":
      return renderText(element);
    case "image":
      return renderImage(element);
    case "ink":
    case "shape":
    case "connector":
      return (
        <div
          aria-hidden="true"
          data-canvas-element-id={element.id}
          data-canvas-element-type={element.type}
          hidden
        />
      );
  }
}
