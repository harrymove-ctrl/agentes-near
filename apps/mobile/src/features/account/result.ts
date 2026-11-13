import { ApiError } from "@agenteschat/client";

/** What `DELETE /api/app/account` answered (pure: tested without React Native). */
export type DeleteAccountResult =
  | { ok: true }
  /** The only owner of organizations that have other members: hand them over, or delete them, first. */
  | { ok: false; reason: "sole_owner"; organizations: string[] }
  /** The proof that it's them was refused (`reauth.code_wrong`, `reauth.password`…): `error` says why. */
  | { ok: false; reason: "proof"; error: ApiError }
  /** Too many password tries: a few minutes before the next. */
  | { ok: false; reason: "rate_limited" }
  | { ok: false; reason: "failed"; status: number };

export async function readDeleteResponse(res: {
  status: number;
  ok: boolean;
  text(): Promise<string>;
}): Promise<DeleteAccountResult> {
  if (res.ok) return { ok: true };
  let body: unknown;
  try {
    body = JSON.parse(await res.text());
  } catch {
    body = undefined;
  }
  const error = (body as { error?: { code?: unknown; message?: unknown; params?: { organizations?: unknown } } })
    ?.error;
  if (res.status === 409 && error?.code === "sole_owner") {
    const list = error.params?.organizations;
    return {
      ok: false,
      reason: "sole_owner",
      organizations: Array.isArray(list) ? list.filter((o): o is string => typeof o === "string") : [],
    };
  }
  if (typeof error?.code === "string" && error.code.startsWith("reauth."))
    return { ok: false, reason: "proof", error: new ApiError(res.status, error.code, String(error.message ?? "")) };
  if (res.status === 429) return { ok: false, reason: "rate_limited" };
  return { ok: false, reason: "failed", status: res.status };
}
