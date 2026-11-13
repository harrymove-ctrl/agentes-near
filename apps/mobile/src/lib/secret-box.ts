import type { SecretBox } from "@agenteschat/client";
import { getRandomBytes } from "expo-crypto";
import { sealSecretWith } from "./secret-seal";

/** A secret sealed on the phone to the computer's key for this request (./secret-seal.ts), with the system's random bytes. */
export const sealSecret = (recipientPublicKey: string, plaintext: string, aad: string): Promise<SecretBox> =>
  Promise.resolve().then(() => sealSecretWith(getRandomBytes, recipientPublicKey, plaintext, aad));
