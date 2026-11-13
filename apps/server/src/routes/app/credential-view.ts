import { endpointPricesFromUsd, endpointPricesToUsd, type listCredentials } from "@agenteschat/engine";
import type { z } from "@hono/zod-openapi";
import { iso } from "./context";
import type { EndpointModel } from "./schemas";

type ModelIn = z.infer<typeof EndpointModel>;
type CredentialRow = Awaited<ReturnType<typeof listCredentials>>[number];

export const modelIn = ({ prices, check: _check, ...m }: ModelIn) => ({
  ...m,
  ...(prices ? { prices: endpointPricesFromUsd(prices) } : {}),
});
export const modelOut = ({ prices, ...m }: NonNullable<CredentialRow["endpoint"]>["models"][number]) => ({
  ...m,
  ...(prices ? { prices: endpointPricesToUsd(prices) } : {}),
});

/** A credential as the API shows it: dates as text, an endpoint's prices per million tokens. */
export const credentialOut = ({ endpoint, ...r }: CredentialRow) => ({
  ...r,
  ...(endpoint ? { endpoint: { ...endpoint, models: endpoint.models.map(modelOut) } } : {}),
  createdAt: r.createdAt.toISOString(),
  revokedAt: iso(r.revokedAt),
});
