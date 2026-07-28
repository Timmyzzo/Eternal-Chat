import type { PreparedDispatch, RequestPreview } from "@/application/chat/requestAssembler";
import type { RequestSnapshot } from "@/domain/chat";
import { emptyRequestFieldSources } from "@/application/providers/requestConfiguration";

export interface InspectionState {
  manifestItems: number;
  modelRevision: number;
  preview: RequestPreview;
  profileRevision: number;
  snapshot: RequestSnapshot;
}

export function inspectionFromDispatch(dispatch: PreparedDispatch): InspectionState {
  return {
    manifestItems: dispatch.contextManifest.items.length,
    modelRevision: dispatch.modelRevision,
    preview: structuredClone(dispatch.preview),
    profileRevision: dispatch.profileRevision,
    snapshot: structuredClone(dispatch.requestSnapshot),
  };
}

export function inspectionFromSnapshot(snapshot: RequestSnapshot): InspectionState {
  const params = isRecord(snapshot.params) ? snapshot.params : {};
  const manifest = isRecord(snapshot.contextManifest) ? snapshot.contextManifest : {};
  return {
    manifestItems: Array.isArray(manifest.items) ? manifest.items.length : 0,
    modelRevision: typeof params.modelSchemaRevision === "number" ? params.modelSchemaRevision : 0,
    preview: {
      body: snapshot.requestBody,
      headers: readFields(snapshot.requestHeaders),
      method: snapshot.requestMethod,
      query: readFields(snapshot.requestQuery),
      sources: readSources(params.fieldSources),
      timeoutMs: null,
      url: snapshot.requestUrl,
    },
    profileRevision: snapshot.protocolProfileRevision,
    snapshot: structuredClone(snapshot),
  };
}

function readSources(value: unknown): RequestPreview["sources"] {
  if (!isRecord(value)) return emptyRequestFieldSources();
  const body = isRecord(value.body) ? value.body : {};
  const headers = isRecord(value.headers) ? value.headers : {};
  const path = isRecord(value.path) ? value.path : {};
  const query = isRecord(value.query) ? value.query : {};
  return { body, headers, path, query } as RequestPreview["sources"];
}

function readFields(value: unknown): Array<{ name: string; value: string }> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((field) =>
    isRecord(field) && typeof field.name === "string" && typeof field.value === "string"
      ? [{ name: field.name, value: field.value }]
      : [],
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
