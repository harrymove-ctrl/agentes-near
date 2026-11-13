import type { z } from "zod";
import { ValidationError } from "./errors";

/** An opaque page cursor: the sort key of a page's last row, as base64url JSON. */
export const encodeCursor = (key: readonly unknown[]) => Buffer.from(JSON.stringify(key)).toString("base64url");

/** The sort key in `cursor`, checked against `shape`; a ValidationError `invalid_cursor` when it isn't one. */
export function decodeCursor<T>(cursor: string, shape: z.ZodType<T>): T {
  try {
    return shape.parse(JSON.parse(Buffer.from(cursor, "base64url").toString()));
  } catch {
    throw new ValidationError("Invalid cursor", "invalid_cursor");
  }
}
