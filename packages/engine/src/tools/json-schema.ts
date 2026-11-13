/**
 * Minimal JSON Schema validation for tool inputs: the model's arguments are
 * untrusted (with eager input streaming the provider no longer validates
 * them), so the Tool Gateway checks them before anything runs. Supports the
 * subset tool schemas use: type, properties, required, additionalProperties
 * (false), enum, items, min/maxLength, minimum/maximum, min/maxItems.
 * Unknown keywords are ignored.
 */
export type JsonSchema = Record<string, unknown>;

export function validateJson(schema: JsonSchema, value: unknown, path = "input"): string[] {
  const errors: string[] = [];
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.length > 0 && !types.some((t) => matchesType(String(t), value))) {
    return [`${path}: expected ${types.join(" or ")}`];
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    errors.push(`${path}: must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`);
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength)
      errors.push(`${path}: too short (at least ${schema.minLength} characters)`);
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength)
      errors.push(`${path}: too long (at most ${schema.maxLength} characters)`);
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) errors.push(`${path}: below ${schema.minimum}`);
    if (typeof schema.maximum === "number" && value > schema.maximum) errors.push(`${path}: above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) errors.push(`${path}: too few items`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) errors.push(`${path}: too many items`);
    if (schema.items && typeof schema.items === "object") {
      value.forEach((item, i) => {
        errors.push(...validateJson(schema.items as JsonSchema, item, `${path}[${i}]`));
      });
    }
  }
  if (isObject(value)) {
    const properties = (isObject(schema.properties) ? schema.properties : {}) as Record<string, JsonSchema>;
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
      if (!(String(key) in value)) errors.push(`${path}.${String(key)}: required`);
    }
    for (const [key, v] of Object.entries(value)) {
      const sub = properties[key];
      if (sub) errors.push(...validateJson(sub, v, `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${key}: not allowed`);
      else if (isObject(schema.additionalProperties))
        errors.push(...validateJson(schema.additionalProperties as JsonSchema, v, `${path}.${key}`));
    }
  }
  return errors;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "object":
      return isObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return true;
  }
}

/** JSON with object keys sorted at every level: equal values always serialize the same (approval hashes). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .filter((k) => value[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}
