import type { CanvasElement, ConnectorElement } from "../model/elements";
import { resolveConnectorPoints } from "../model/connectorBinding";
import type { CanvasPoint } from "../model/geometry";

export type ConnectorPreviewGeometry = Readonly<{
  connector: ConnectorElement;
  points: Readonly<{ start: CanvasPoint; end: CanvasPoint }> | null;
}>;

/** Adds only transformed immutable refs over a stable scene index. */
export function overlayTransformedElements(
  baseElementsById: Readonly<Record<string, CanvasElement>>,
  transformedElements: readonly CanvasElement[],
): Readonly<Record<string, CanvasElement>> {
  const overlay = Object.create(baseElementsById) as Record<string, CanvasElement>;
  for (const element of transformedElements) overlay[element.id] = element;
  return overlay;
}

/** Resolves exactly the connector IDs captured by the active transform session. */
export function resolveAffectedConnectorGeometry(
  elementsById: Readonly<Record<string, CanvasElement>>,
  connectorIds: ReadonlySet<string>,
): ConnectorPreviewGeometry[] {
  const previews: ConnectorPreviewGeometry[] = [];
  forEachAffectedConnectorGeometry(elementsById, connectorIds, (preview) => previews.push(preview));
  return previews;
}

/** Visits affected connector geometry without allocating a scene-sized intermediate array. */
export function forEachAffectedConnectorGeometry(
  elementsById: Readonly<Record<string, CanvasElement>>,
  connectorIds: ReadonlySet<string>,
  visit: (preview: ConnectorPreviewGeometry) => void,
) {
  for (const connectorId of connectorIds) {
    const connector = elementsById[connectorId];
    if (!connector || connector.type !== "connector") continue;
    visit({ connector, points: resolveConnectorPoints(connector, elementsById) });
  }
}
