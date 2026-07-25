import type { EventDraft } from "../../native/calendarClient";

export const ASSISTANT_SCHEMA_VERSION = 1;
export const MAX_TOOL_CALLS_PER_ROUND = 8;
export const MAX_TOOL_CALLS_TOTAL = 24;
export const MAX_TOOL_ROUNDS = 5;
const NOTE_MAXIMUM_RESULT_BYTES = 16_000;
const CALENDAR_MAXIMUM_RESULT_BYTES = 128 * 1024;

export type ToolRisk = "read" | "write";
export type ProviderToolSchema = { type: "object"; additionalProperties: false; properties: Record<string, unknown>; required: readonly string[]; anyOf?: readonly unknown[]; dependentRequired?: Readonly<Record<string, readonly string[]>> };
export type ProviderOutputSchema = Readonly<Record<string, unknown>> & { maximumBytes: number; completenessRequired: boolean };
export type ToolOperation =
  | "notes.read_page" | "notes.read_selection" | "notes.search" | "notes.insert_text" | "notes.append_text" | "notes.replace_text"
  | "calendar.query" | "calendar.search" | "calendar.get_event" | "calendar.create_event"
  | "legacy.note.getCurrentPage" | "legacy.note.getSelectedBlocks" | "legacy.note.searchPages" | "legacy.note.createBlock" | "legacy.note.updateBlock" | "legacy.note.deleteBlock" | "legacy.note.moveBlock" | "legacy.note.createPage" | "legacy.note.renamePage" | "legacy.note.openPage";
export type ToolDefinition = {
  id: string;
  schemaVersion: 1;
  description: string;
  risk: ToolRisk;
  confirmationRequired: boolean;
  authorizedWindows: readonly ["main"];
  timeoutMs: number;
  maximumResultBytes: number;
  providerDataSharing: "bounded_note_content" | "sanitized_calendar_content";
  inputSchema: ProviderToolSchema;
  outputSchema: ProviderOutputSchema;
  compatibilityAliasFor?: string;
  operation: ToolOperation;
  validate(input: unknown): Record<string, unknown>;
};

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Tool input must be an object.");
  return value as Record<string, unknown>;
};
const hasOwn = (value: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(value, key);
const exact = (value: unknown, keys: readonly string[]) => {
  const result = record(value);
  if (Object.keys(result).some((key) => !keys.includes(key))) throw new Error("Tool input contains an unsupported field.");
  return result;
};
const string = (value: unknown, field: string, max = 4000) => {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${field} must be bounded text.`);
  return value;
};
const id = (value: unknown, field = "id") => string(value, field, 200);
const finite = (value: unknown, field: string) => { if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${field} must be a number.`); return value; };
const integer = (value: unknown, field: string) => { const number = finite(value, field); if (!Number.isInteger(number)) throw new Error(`${field} must be an integer.`); return number; };
const boundedGeometry = (value: unknown, field: string) => {
  const number = finite(value, field);
  const isSize = field === "width" || field === "height";
  if ((isSize && (number < 20 || number > 10_000)) || (!isSize && Math.abs(number) > 100_000)) {
    throw new Error(`${field} is outside the supported canvas bounds.`);
  }
  return number;
};
const optionalString = (value: unknown, field: string, max = 4000) => value === undefined ? undefined : string(value, field, max);
const event = (value: unknown): EventDraft => {
  const input = exact(value, ["title", "notes", "location", "time", "recurrenceRule", "reminderOffsetsMinutes"]);
  const time = record(input.time);
  if (time.temporalKind === "timed") {
    exact(time, ["temporalKind", "localStart", "localEnd", "timeZone"]);
    return { title: string(input.title, "title", 500), notes: input.notes === null ? null : optionalString(input.notes, "notes", 8000) ?? null, location: input.location === null ? null : optionalString(input.location, "location", 1000) ?? null, time: { temporalKind: "timed", localStart: string(time.localStart, "localStart", 64), localEnd: string(time.localEnd, "localEnd", 64), timeZone: string(time.timeZone, "timeZone", 128) }, recurrenceRule: input.recurrenceRule === null ? null : optionalString(input.recurrenceRule, "recurrenceRule", 512), reminderOffsetsMinutes: input.reminderOffsetsMinutes === undefined ? undefined : validatedReminders(input.reminderOffsetsMinutes) };
  }
  exact(time, ["temporalKind", "startDate", "endDateExclusive"]);
  if (time.temporalKind !== "allDay") throw new Error("time.temporalKind is unsupported.");
  return { title: string(input.title, "title", 500), notes: input.notes === null ? null : optionalString(input.notes, "notes", 8000) ?? null, location: input.location === null ? null : optionalString(input.location, "location", 1000) ?? null, time: { temporalKind: "allDay", startDate: string(time.startDate, "startDate", 32), endDateExclusive: string(time.endDateExclusive, "endDateExclusive", 32) }, recurrenceRule: input.recurrenceRule === null ? null : optionalString(input.recurrenceRule, "recurrenceRule", 512), reminderOffsetsMinutes: input.reminderOffsetsMinutes === undefined ? undefined : validatedReminders(input.reminderOffsetsMinutes) };
};
const validatedReminders = (value: unknown) => {
  if (!Array.isArray(value) || value.length > 5 || new Set(value).size !== value.length) throw new Error("reminderOffsetsMinutes is invalid.");
  return value.map((item) => { const minutes = integer(item, "reminderOffsetsMinutes"); if (minutes < 0 || minutes > 50_400) throw new Error("reminderOffsetsMinutes is invalid."); return minutes; });
};
const schema = (properties: Record<string, unknown>, required: readonly string[] = []): ProviderToolSchema => ({ type: "object", additionalProperties: false, properties, required });
const stringProperty = (maxLength: number) => ({ type: "string", minLength: 1, maxLength });
const outputStringProperty = (maxLength: number) => ({ type: "string", maxLength });
const numberProperty = { type: "number", minimum: -100_000, maximum: 100_000 };
function providerInputSchema(id: string): ProviderToolSchema {
  if (["notes.read_selection", "note.getSelectedBlocks"].includes(id)) return schema({});
  if (["notes.read_page", "note.getCurrentPage"].includes(id)) return schema({ includeBlocks: { type: "boolean" } });
  if (["notes.search", "note.searchPages"].includes(id)) return schema({ query: stringProperty(300) }, ["query"]);
  if (["notes.insert_text", "note.createBlock"].includes(id)) return { ...schema({ content: stringProperty(4000), x: numberProperty, y: numberProperty }, ["content"]), dependentRequired: { x: ["y"], y: ["x"] } };
  if (["notes.append_text", "notes.replace_text"].includes(id)) return schema({ blockId: stringProperty(200), content: stringProperty(4000) }, ["blockId", "content"]);
  if (id === "note.updateBlock") return { ...schema({ blockId: stringProperty(200), content: stringProperty(4000), x: numberProperty, y: numberProperty, width: { type: "number", minimum: 20, maximum: 10_000 }, height: { type: "number", minimum: 20, maximum: 10_000 } }, ["blockId"]), anyOf: ["content", "x", "y", "width", "height"].map((key) => ({ required: [key] })) };
  if (id === "note.deleteBlock" || id === "note.openPage") return schema({ [id === "note.deleteBlock" ? "blockId" : "pageId"]: stringProperty(200) }, [id === "note.deleteBlock" ? "blockId" : "pageId"]);
  if (id === "note.moveBlock") return schema({ blockId: stringProperty(200), x: numberProperty, y: numberProperty }, ["blockId", "x", "y"]);
  if (id === "note.createPage") return schema({ title: stringProperty(4000), folderId: stringProperty(200) }, ["title"]);
  if (id === "note.renamePage") return schema({ pageId: stringProperty(200), title: stringProperty(4000) }, ["pageId", "title"]);
  if (id === "calendar.get_event") return schema({ eventId: stringProperty(200) }, ["eventId"]);
  if (id === "calendar.query" || id === "calendar.search") return schema({ ...(id === "calendar.search" ? { query: stringProperty(300) } : {}), startUtcMs: { type: "integer" }, endUtcMs: { type: "integer" }, startDate: stringProperty(32), endDateExclusive: stringProperty(32), limit: { type: "integer", minimum: 1, maximum: id === "calendar.search" ? 20 : 25 } }, [...(id === "calendar.search" ? ["query"] : []), "startUtcMs", "endUtcMs", "startDate", "endDateExclusive", "limit"]);
  const timed = schema(
    {
      temporalKind: { const: "timed" },
      localStart: stringProperty(64),
      localEnd: stringProperty(64),
      timeZone: stringProperty(128),
    },
    ["temporalKind", "localStart", "localEnd", "timeZone"],
  );
  const allDay = schema(
    {
      temporalKind: { const: "allDay" },
      startDate: stringProperty(32),
      endDateExclusive: stringProperty(32),
    },
    ["temporalKind", "startDate", "endDateExclusive"],
  );
  return schema(
    {
      event: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: stringProperty(500),
          notes: { anyOf: [{ type: "null" }, stringProperty(8000)] },
          location: { anyOf: [{ type: "null" }, stringProperty(1000)] },
          time: { oneOf: [timed, allDay] },
          recurrenceRule: { anyOf: [{ type: "null" }, stringProperty(512)] },
          reminderOffsetsMinutes: { type: "array", maxItems: 5, uniqueItems: true, items: { type: "integer", minimum: 0, maximum: 50_400 } },
        },
        required: ["title", "notes", "location", "time"],
      },
      inferredFields: {
        type: "array",
        maxItems: 9,
        uniqueItems: true,
        items: { enum: ["title", "time", "timeZone", "duration", "allDay", "recurrence", "reminders", "location", "notes"] },
      },
    },
    ["event"],
  );
}
const nullable = (value: unknown) => ({ anyOf: [{ type: "null" }, value] });
const stringArray = (maxItems: number, items: unknown = { type: "string" }) => ({ type: "array", maxItems, items });
const notePageOutput = schema({ id: outputStringProperty(200), folderId: outputStringProperty(200), title: outputStringProperty(4000), isBookmarked: { type: "boolean" }, truncatedFields: stringArray(1, { const: "title" }) }, ["id", "folderId", "title"]);
const noteBlockOutput = schema({ id: outputStringProperty(200), pageId: outputStringProperty(200), content: outputStringProperty(4000), x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" }, truncatedFields: stringArray(1, { const: "content" }) }, ["id", "pageId", "content", "x", "y", "width", "height"]);
const noteCompletenessOutput = schema({ complete: { type: "boolean" }, omittedCount: { type: "integer", minimum: 0 }, truncatedContentCount: { type: "integer", minimum: 0 }, maximumCount: { type: "integer", minimum: 1 }, maximumBytes: { const: NOTE_MAXIMUM_RESULT_BYTES } }, ["complete", "omittedCount", "maximumBytes"]);
const noteSearchCompletenessOutput = schema({ complete: { type: "boolean" }, omittedPageCount: { type: "integer", minimum: 0 }, omittedMatchCount: { type: "integer", minimum: 0 }, truncatedTitleCount: { type: "integer", minimum: 0 }, maximumPages: { type: "integer", minimum: 1 }, maximumMatchesPerPage: { type: "integer", minimum: 1 }, maximumMatchesTotal: { type: "integer", minimum: 1 }, maximumBytes: { const: NOTE_MAXIMUM_RESULT_BYTES } }, ["complete", "omittedPageCount", "omittedMatchCount", "truncatedTitleCount", "maximumPages", "maximumMatchesPerPage", "maximumMatchesTotal", "maximumBytes"]);
const cancelledOutput = schema({ status: { const: "cancelled" } }, ["status"]);
const writeOutput = (success: ProviderToolSchema) => ({ oneOf: [success, cancelledOutput] });
const timedEventOutput = schema({ temporalKind: { const: "timed" }, startUtcMs: { type: "integer" }, endUtcMs: { type: "integer" }, timeZone: outputStringProperty(128) }, ["temporalKind", "startUtcMs", "endUtcMs", "timeZone"]);
const allDayEventOutput = schema({ temporalKind: { const: "allDay" }, startDate: outputStringProperty(32), endDateExclusive: outputStringProperty(32) }, ["temporalKind", "startDate", "endDateExclusive"]);
const calendarEventOutput = schema({ eventId: outputStringProperty(200), title: outputStringProperty(200), notes: nullable(outputStringProperty(500)), location: nullable(outputStringProperty(200)), time: { oneOf: [timedEventOutput, allDayEventOutput] }, recurrenceRule: nullable(outputStringProperty(512)), reminderOffsetsMinutes: stringArray(5, { type: "integer", minimum: 0, maximum: 50_400 }), revision: { type: "integer" }, source: { const: "local_calendar" }, truncatedFields: stringArray(3, { enum: ["title", "notes", "location"] }) }, ["eventId", "title", "notes", "location", "time", "recurrenceRule", "reminderOffsetsMinutes", "revision", "source"]);
const calendarOccurrenceOutput = schema({ ...calendarEventOutput.properties, occurrenceKey: outputStringProperty(200) }, [...calendarEventOutput.required, "occurrenceKey"]);
const calendarListOutput = (maximumItems: number, completeness: readonly string[], omittedCount: unknown) => schema({ items: { type: "array", maxItems: maximumItems, items: calendarOccurrenceOutput }, completeness: { enum: completeness }, omittedCount }, ["items", "completeness", "omittedCount"]);
const calendarCreatedOutput = schema({ status: { const: "created" }, event: calendarEventOutput, providerResult: schema({ status: { const: "created" }, event: calendarEventOutput }, ["status", "event"]), replayed: { type: "boolean" } }, ["status", "event", "providerResult", "replayed"]);
const calendarCancelledOutput = schema({ status: { const: "cancelled" }, providerResult: cancelledOutput, replayed: { type: "boolean" } }, ["status", "providerResult", "replayed"]);
const calendarCreateOutput = { oneOf: [calendarCreatedOutput, calendarCancelledOutput] };

function providerOutputContract(id: string): { contract: Readonly<Record<string, unknown>>; completenessRequired: boolean } {
  if (["notes.read_page", "note.getCurrentPage"].includes(id)) return { contract: schema({ page: notePageOutput, blocks: { type: "array", maxItems: 24, items: noteBlockOutput }, completeness: noteCompletenessOutput }, ["page", "completeness"]), completenessRequired: true };
  if (["notes.read_selection", "note.getSelectedBlocks"].includes(id)) return { contract: schema({ blocks: { type: "array", maxItems: 12, items: noteBlockOutput }, completeness: noteCompletenessOutput }, ["blocks", "completeness"]), completenessRequired: true };
  if (["notes.search", "note.searchPages"].includes(id)) return { contract: schema({ pages: { type: "array", maxItems: 20, items: schema({ id: outputStringProperty(200), folderId: outputStringProperty(200), title: outputStringProperty(200), matchedBlockIds: stringArray(20, outputStringProperty(200)), truncatedFields: stringArray(1, { const: "title" }) }, ["id", "folderId", "title", "matchedBlockIds"]) }, completeness: noteSearchCompletenessOutput }, ["pages", "completeness"]), completenessRequired: true };
  if (["notes.insert_text", "notes.append_text", "notes.replace_text", "note.createBlock", "note.updateBlock", "note.moveBlock"].includes(id)) return { contract: writeOutput(schema({ block: noteBlockOutput }, ["block"])), completenessRequired: false };
  if (id === "note.deleteBlock") return { contract: writeOutput(schema({ deletedBlockId: outputStringProperty(200) }, ["deletedBlockId"])), completenessRequired: false };
  if (["note.createPage", "note.renamePage", "note.openPage"].includes(id)) return { contract: writeOutput(schema({ page: notePageOutput }, ["page"])), completenessRequired: false };
  if (id === "calendar.query") return { contract: calendarListOutput(25, ["complete", "truncated"], { type: "integer", minimum: 0 }), completenessRequired: true };
  if (id === "calendar.search") return { contract: calendarListOutput(20, ["complete", "unknown_beyond_limit"], { type: "null" }), completenessRequired: true };
  if (id === "calendar.get_event") return { contract: calendarEventOutput, completenessRequired: false };
  return { contract: calendarCreateOutput, completenessRequired: false };
}

function providerOutputSchema(id: string, maximumBytes: number): ProviderOutputSchema {
  const { contract, completenessRequired } = providerOutputContract(id);
  return { ...contract, maximumBytes, completenessRequired };
}

function assertSchema(value: unknown, definition: unknown, path: string): void {
  const contract = definition as Record<string, unknown>;
  const variants = contract.oneOf ?? contract.anyOf;
  if (Array.isArray(variants)) {
    const matches = variants.filter((variant) => { try { assertSchema(value, variant, path); return true; } catch { return false; } }).length;
    if ((contract.oneOf !== undefined && matches !== 1) || (contract.anyOf !== undefined && matches < 1)) throw new Error(`${path} does not match its declared output schema.`);
    return;
  }
  if (hasOwn(contract, "const") && value !== contract.const) throw new Error(`${path} does not match its declared constant.`);
  if (Array.isArray(contract.enum) && !contract.enum.includes(value)) throw new Error(`${path} is outside its declared values.`);
  if (contract.type === "null") { if (value !== null) throw new Error(`${path} must be null.`); return; }
  if (contract.type === "string") {
    if (typeof value !== "string" || (typeof contract.minLength === "number" && value.length < contract.minLength) || (typeof contract.maxLength === "number" && value.length > contract.maxLength)) throw new Error(`${path} is outside its declared text bounds.`);
    return;
  }
  if (contract.type === "number" || contract.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value) || (contract.type === "integer" && !Number.isInteger(value)) || (typeof contract.minimum === "number" && value < contract.minimum) || (typeof contract.maximum === "number" && value > contract.maximum)) throw new Error(`${path} is outside its declared number bounds.`);
    return;
  }
  if (contract.type === "boolean") { if (typeof value !== "boolean") throw new Error(`${path} must be boolean.`); return; }
  if (contract.type === "array") {
    if (!Array.isArray(value) || (typeof contract.maxItems === "number" && value.length > contract.maxItems)) throw new Error(`${path} is outside its declared list bounds.`);
    if (contract.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) throw new Error(`${path} must contain unique values.`);
    value.forEach((item, index) => assertSchema(item, contract.items, `${path}[${index}]`));
    return;
  }
  if (contract.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object.`);
    const object = value as Record<string, unknown>;
    const properties = contract.properties as Record<string, unknown>;
    const required = contract.required as readonly string[];
    if (required.some((key) => !hasOwn(object, key)) || (contract.additionalProperties === false && Object.keys(object).some((key) => !hasOwn(properties, key)))) throw new Error(`${path} does not match its declared fields.`);
    for (const [key, item] of Object.entries(object)) if (hasOwn(properties, key)) assertSchema(item, properties[key], `${path}.${key}`);
  }
}
const descriptions: Record<string, string> = {
  "notes.read_page": "Read bounded text snippets from the active Note page.", "notes.read_selection": "Read bounded selected text snippets.", "notes.search": "Search Note page titles and matched block identifiers with explicit completeness.", "notes.insert_text": "Propose inserting text on the active page; requires user review.", "notes.append_text": "Propose appending text to one active-page block; requires user review.", "notes.replace_text": "Propose replacing one active-page block; requires user review.", "calendar.query": "Query up to 25 calendar occurrences in a bounded range.", "calendar.search": "Search up to 20 calendar occurrences with explicit completeness.", "calendar.get_event": "Read one sanitized calendar event.", "calendar.create_event": "Propose one calendar event for explicit user review.",
  "note.updateBlock": "Compatibility tool to propose changing text or geometry on one active-page block.", "note.deleteBlock": "Compatibility tool to propose deleting one active-page block.", "note.moveBlock": "Compatibility tool to propose moving one active-page block.", "note.createPage": "Compatibility tool to propose creating a page in a bounded folder target.", "note.renamePage": "Compatibility tool to propose renaming one page.", "note.openPage": "Compatibility tool to propose opening one page without changing note content.",
};
const legacyAliases: Record<string, string> = { "note.getCurrentPage": "notes.read_page", "note.getSelectedBlocks": "notes.read_selection", "note.searchPages": "notes.search", "note.createBlock": "notes.insert_text" };
const definition = (id: string, risk: ToolRisk, operation: ToolOperation, validate: ToolDefinition["validate"]): ToolDefinition => {
  const maximumResultBytes = id.startsWith("calendar.") ? CALENDAR_MAXIMUM_RESULT_BYTES : NOTE_MAXIMUM_RESULT_BYTES;
  return { id, schemaVersion: 1, description: descriptions[id] ?? `Compatibility alias for ${legacyAliases[id]}.`, risk, confirmationRequired: risk === "write", authorizedWindows: ["main"], timeoutMs: risk === "read" ? 10_000 : 120_000, maximumResultBytes, providerDataSharing: id.startsWith("calendar.") ? "sanitized_calendar_content" : "bounded_note_content", inputSchema: providerInputSchema(id), outputSchema: providerOutputSchema(id, maximumResultBytes), ...(legacyAliases[id] ? { compatibilityAliasFor: legacyAliases[id] } : {}), operation, validate };
};
const noArgs = () => (value: unknown) => { exact(value, []); return {}; };
const text = (keys: readonly string[], required: readonly string[] = ["content"]) => (value: unknown) => {
  const input = exact(value, keys);
  for (const key of required) {
    if (["folderId", "pageId", "blockId"].includes(key)) id(input[key], key);
    else string(input[key], key);
  }
  for (const key of ["content", "title"]) {
    if (input[key] !== undefined) string(input[key], key, 4000);
  }
  for (const key of ["folderId", "pageId", "blockId"]) {
    if (input[key] !== undefined) id(input[key], key);
  }
  for (const key of ["x", "y", "width", "height"]) {
    if (input[key] !== undefined) boundedGeometry(input[key], key);
  }
  return input;
};
const positionedText = (value: unknown) => {
  const input = text(["content", "x", "y"])(value);
  if ((input.x === undefined) !== (input.y === undefined)) throw new Error("x and y must be provided together.");
  return input;
};

/** Note owns this single v1 allowlist; provider labels and risk declarations are ignored. */
export const assistantToolRegistry: readonly ToolDefinition[] = [
  definition("notes.read_page", "read", "notes.read_page", (value) => { const input = exact(value, ["includeBlocks"]); if (input.includeBlocks !== undefined && typeof input.includeBlocks !== "boolean") throw new Error("includeBlocks must be boolean."); return input; }),
  definition("notes.read_selection", "read", "notes.read_selection", noArgs()),
  definition("notes.search", "read", "notes.search", (value) => { const input = exact(value, ["query"]); return { query: string(input.query, "query", 300) }; }),
  definition("notes.insert_text", "write", "notes.insert_text", positionedText),
  definition("notes.append_text", "write", "notes.append_text", text(["blockId", "content"])),
  definition("notes.replace_text", "write", "notes.replace_text", text(["blockId", "content"])),
  definition("calendar.query", "read", "calendar.query", (value) => { const input = exact(value, ["startUtcMs", "endUtcMs", "startDate", "endDateExclusive", "limit"]); return { ...input, startUtcMs: integer(input.startUtcMs, "startUtcMs"), endUtcMs: integer(input.endUtcMs, "endUtcMs"), startDate: string(input.startDate, "startDate", 32), endDateExclusive: string(input.endDateExclusive, "endDateExclusive", 32), limit: checkedLimit(input.limit, 25) }; }),
  definition("calendar.search", "read", "calendar.search", (value) => { const input = exact(value, ["query", "startUtcMs", "endUtcMs", "startDate", "endDateExclusive", "limit"]); return { ...input, query: string(input.query, "query", 300), startUtcMs: integer(input.startUtcMs, "startUtcMs"), endUtcMs: integer(input.endUtcMs, "endUtcMs"), startDate: string(input.startDate, "startDate", 32), endDateExclusive: string(input.endDateExclusive, "endDateExclusive", 32), limit: checkedLimit(input.limit, 20) }; }),
  definition("calendar.get_event", "read", "calendar.get_event", (value) => ({ eventId: id(exact(value, ["eventId"]).eventId, "eventId") })),
  definition("calendar.create_event", "write", "calendar.create_event", (value) => { const input = exact(value, ["event", "inferredFields"]); const inferredFields = input.inferredFields === undefined ? undefined : validatedInferred(input.inferredFields); return { event: event(input.event), ...(inferredFields ? { inferredFields } : {}) }; }),
  definition("note.getCurrentPage", "read", "legacy.note.getCurrentPage", (value) => { const input = exact(value, ["includeBlocks"]); if (input.includeBlocks !== undefined && typeof input.includeBlocks !== "boolean") throw new Error("includeBlocks must be boolean."); return input; }),
  definition("note.getSelectedBlocks", "read", "legacy.note.getSelectedBlocks", noArgs()),
  definition("note.searchPages", "read", "legacy.note.searchPages", (value) => ({ query: string(exact(value, ["query"]).query, "query", 300) })),
  definition("note.createBlock", "write", "legacy.note.createBlock", positionedText),
  definition("note.updateBlock", "write", "legacy.note.updateBlock", (value) => { const input = text(["blockId", "content", "x", "y", "width", "height"], ["blockId"])(value); if (["content", "x", "y", "width", "height"].every((key) => input[key] === undefined)) throw new Error("At least one block field is required."); return input; }),
  definition("note.deleteBlock", "write", "legacy.note.deleteBlock", (value) => ({ blockId: id(exact(value, ["blockId"]).blockId, "blockId") })),
  definition("note.moveBlock", "write", "legacy.note.moveBlock", (value) => { const input = exact(value, ["blockId", "x", "y"]); return { blockId: id(input.blockId, "blockId"), x: boundedGeometry(input.x, "x"), y: boundedGeometry(input.y, "y") }; }),
  definition("note.createPage", "write", "legacy.note.createPage", text(["title", "folderId"], ["title"])),
  definition("note.renamePage", "write", "legacy.note.renamePage", text(["pageId", "title"], ["pageId", "title"])),
  definition("note.openPage", "write", "legacy.note.openPage", (value) => ({ pageId: id(exact(value, ["pageId"]).pageId, "pageId") })),
];
const checkedLimit = (value: unknown, maximum: number) => { const limit = integer(value, "limit"); if (limit < 1 || limit > maximum) throw new Error(`limit must be between 1 and ${maximum}.`); return limit; };
const validatedInferred = (value: unknown) => { const fields = ["title", "time", "timeZone", "duration", "allDay", "recurrence", "reminders", "location", "notes"]; if (!Array.isArray(value) || value.length > fields.length || new Set(value).size !== value.length || value.some((item) => typeof item !== "string" || !fields.includes(item))) throw new Error("inferredFields must contain unique supported fields."); return value as string[]; };
export function resolveAssistantTool(toolId: string, schemaVersion: unknown) { const tool = assistantToolRegistry.find((candidate) => candidate.id === toolId); if (!tool) throw new Error("This assistant tool is not allowed."); if (schemaVersion !== tool.schemaVersion) throw new Error("This assistant tool schema version is not supported."); return tool; }
export function validateAssistantToolResult(tool: ToolDefinition, result: unknown) { assertSchema(result, tool.outputSchema, `${tool.id} result`); return result; }
export function getAssistantToolManifest() {
  return {
    schemaVersion: ASSISTANT_SCHEMA_VERSION,
    limits: { maximumCallsPerRound: MAX_TOOL_CALLS_PER_ROUND, maximumCallsTotal: MAX_TOOL_CALLS_TOTAL, maximumRounds: MAX_TOOL_ROUNDS },
    tools: assistantToolRegistry.map(({ validate: _validate, operation: _operation, ...tool }) => tool),
    compatibilityAliases: assistantToolRegistry.filter((tool) => tool.compatibilityAliasFor).map((tool) => ({ id: tool.id, schemaVersion: tool.schemaVersion, aliasFor: tool.compatibilityAliasFor })),
  };
}
export type AssistantToolManifest = ReturnType<typeof getAssistantToolManifest>;
