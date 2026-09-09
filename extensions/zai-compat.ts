// Z.ai (GLM) tool-schema compatibility for the harness.
//
// The Z.ai OpenAI-compatible endpoint (api.z.ai/api/coding/paas/v4) rejects
// certain standard JSON-Schema constructs in tool parameter schemas with
// `400 {"code":"1210","message":"Invalid API parameter"}` (verified against the
// live API 2026-09-10). Two rewrites make schemas acceptable, both confirmed by
// request bisection against the real endpoint:
//
// 1. Fixed-length tuples (`items: [s1, s2, s3]` + `additionalItems: false`,
//    which TypeBox emits for Type.Tuple) are rejected outright. pi-better-edit's
//    `edit` tool uses one for its `[remove_from, remove_to, replacement_text]`
//    tuples, which made every session and sub-agent fail against Z.ai.
//    Rewrite: `items` array → a single `items` schema of the distinct element
//    types, with `minItems`/`maxItems` pinned to the tuple length (or the
//    schema's existing bounds kept when stricter). `additionalItems` is dropped.
// 2. Nullable unions (`anyOf` with exactly one `{type:"null"}` branch) are also
//    rewritten to `type: [..., "null"]` arrays — accepted by Z.ai and safer for
//    strict validators than keeping applicators around.
//
// Everything else passes through untouched. This extension overrides the
// built-in `zai` provider with one whose transport applies the rewrite to
// outbound tool schemas. It is a no-op for schemas without tuples or nullable
// unions. Remove once pi-better-edit ships a Z.ai-safe schema (or Z.ai accepts
// standard applicators) and this stops earning its keep.
//
// Loader constraints: pi's extension loader resolves only aliased bare
// specifiers for extensions (the pi-ai root + compat entrypoints,
// pi-coding-agent, pi-agent-core, pi-tui, typebox), and standard installs
// (`npm install --omit=dev`) ship no @earendil-works/* in node_modules at all —
// deep subpaths like `@earendil-works/pi-ai/api/openai-completions.lazy`
// (used here previously) or `.../providers/zai` fail with MODULE_NOT_FOUND
// outside a dev checkout. Everything is therefore imported from the aliased
// `@earendil-works/pi-ai/compat` entrypoint: at runtime the loader maps the
// pi-ai root to that same compat bundle, and compat's type surface is a strict
// superset of the core entrypoint's (the core types omit
// `openAICompletionsApi`, so importing it from the root would not type-check).
// The model catalog is vendored verbatim in ./zai-models.ts; regenerate that
// file on pi-ai version bumps so the model list stays in lockstep with the
// built-in provider (this actually mattered: the override briefly hid
// glm-5.3-flash when the checkout still bundled pi-ai 0.84.3 while pi ran
// 0.84.4).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createProvider,
  envApiKeyAuth,
  openAICompletionsApi,
  type Context,
  type ProviderStreams,
  type Tool,
} from "@earendil-works/pi-ai/compat";
import { ZAI_MODELS } from "./zai-models.ts";

type SchemaNode = Record<string, unknown>;

function isObject(value: unknown): value is SchemaNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Collapse a nullable `anyOf`/`oneOf` (exactly one `{type:"null"}` branch) into
 * a JSON-Schema type array. Constraints are taken from the first concrete
 * branch. Unions that don't match this shape are returned unchanged.
 */
function collapseNullableUnion(node: SchemaNode, branches: unknown[]): SchemaNode {
  const concrete = branches.filter((b): b is SchemaNode => isObject(b) && b.type !== "null");
  const nullish = branches.filter((b) => isObject(b) && b.type === "null");
  if (nullish.length !== 1 || concrete.length < 1 || !concrete.every((b) => typeof b.type === "string")) {
    return node;
  }
  const merged: SchemaNode = { ...concrete[0] };
  merged.type = [...new Set([...concrete.map((b) => b.type as string), "null"])];
  const result: SchemaNode = { ...node };
  delete result.anyOf;
  delete result.oneOf;
  Object.assign(result, merged);
  return result;
}

/**
 * Rewrite a fixed-length tuple (`items` as an array) into a uniform `items`
 * schema with pinned arity — e.g. `[string, string, string]` becomes
 * `items: {type: "string"}` + `minItems: 3` + `maxItems: 3`. Tuples with
 * elements that have no simple string type are returned unchanged.
 */
function flattenTuple(node: SchemaNode): SchemaNode {
  const items = node.items;
  if (!Array.isArray(items) || items.length === 0 || !items.every(isObject)) return node;
  const types = [...new Set(items.map((b) => b.type))];
  if (!types.every((t) => typeof t === "string")) return node;
  const merged: SchemaNode =
    types.length === 1
      ? { ...items[0] }
      : { type: types };
  delete merged.description; // element description would describe every item; drop to avoid confusion
  const result: SchemaNode = { ...node };
  result.items = merged;
  if (result.minItems === undefined) result.minItems = items.length;
  if (result.maxItems === undefined) result.maxItems = items.length;
  delete result.additionalItems;
  return result;
}

/**
 * Rewrite the constructs Z.ai rejects into equivalent accepted shapes.
 * Pure: returns a new structure, never mutates the input.
 */
function rewriteForZai(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(rewriteForZai);
  if (!isObject(schema)) return schema;

  let node: SchemaNode = { ...schema };
  for (const key of ["anyOf", "oneOf"] as const) {
    if (Array.isArray(node[key])) node = collapseNullableUnion(node, node[key] as unknown[]);
  }
  if (Array.isArray(node.items)) node = flattenTuple(node);

  for (const key of Object.keys(node)) {
    node[key] = rewriteForZai(node[key]);
  }
  return node;
}

/** Clone the context with every tool's parameter schema rewritten. */
function zaiSafeContext(context: Context): Context {
  if (!context.tools || context.tools.length === 0) return context;
  const tools: Tool[] = context.tools.map((tool) => ({
    ...tool,
    parameters: rewriteForZai(tool.parameters) as Tool["parameters"],
  }));
  return { ...context, tools };
}

export default function (pi: ExtensionAPI) {
  const inner: ProviderStreams = openAICompletionsApi();

  const safeApi: ProviderStreams = {
    stream: (model, context, options) => inner.stream(model, zaiSafeContext(context), options),
    streamSimple: (model, context, options) => inner.streamSimple(model, zaiSafeContext(context), options),
  };

  // Replicates pi-ai's zaiProvider() (dist/providers/zai.ts) field-for-field,
  // with `api` swapped for the schema-rewriting transport above and the model
  // catalog vendored in ./zai-models.ts (not importable through the loader
  // aliases). Keep both in sync with that factory on pi-ai bumps.
  const provider = createProvider({
    id: "zai",
    name: "Z.AI",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    auth: { apiKey: envApiKeyAuth("Z.AI API key", ["ZAI_API_KEY"]) },
    models: ZAI_MODELS,
    api: safeApi,
  });
  pi.registerProvider(provider);
}
