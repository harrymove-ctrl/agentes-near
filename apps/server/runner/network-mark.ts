/** A root-configured packet bit, separate from the local-service conntrack ownership tag. */
export function validateNetworkMark(mark: unknown): asserts mark is number {
  if (
    typeof mark !== "number" ||
    !Number.isInteger(mark) ||
    mark <= 0 ||
    mark > 0xffffffff ||
    (mark & (mark - 1)) !== 0 ||
    (mark & 0x41000000) !== 0
  ) {
    throw new Error("networkMark must be a single uint32 packet bit outside the local-service ownership tag");
  }
}

/**
 * A trusted earlier routing hook may deliver a foreign destination through loopback (TPROXY).
 * Do not include `.mark` in the FIB lookup: its policy route intentionally says local. Excluding
 * DNAT also means the checked destination is the original one. A host-owned address, including
 * its public address and wildcard listeners, never takes this exception.
 */
export function networkMarkExemption(mark: number | undefined): string[] {
  if (mark === undefined) return [];
  validateNetworkMark(mark);
  const mask = `0x${mark.toString(16).padStart(8, "0")}`;
  return [
    `\t\tmeta mark & ${mask} == ${mask} ct status != dnat fib daddr type != local return comment "agentes network mark ${mark}"`,
  ];
}
