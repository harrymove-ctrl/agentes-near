import { expect, test } from "bun:test";
import { cheapModelOf, keyCheckRequest, keyFailureWords, keyRefusalOf } from "../src";

test("a test call's failure says what it knows of the key", () => {
  expect(keyRefusalOf({ status: 401, message: "invalid provider API key" })).toBe("invalid");
  expect(keyRefusalOf({ status: 400, message: "provider rejected the request (400): API key not valid." })).toBe(
    "invalid",
  );
  expect(
    keyRefusalOf({ status: 429, message: "no prepaid credit left at the provider (429 insufficient_quota)" }),
  ).toBe("no_credit");
  expect(keyRefusalOf({ status: 402, message: "no prepaid credit left at the provider" })).toBe("no_credit");
  const claude = "provider rejected the request (400 invalid_request_error): Your credit balance is too low";
  expect(keyRefusalOf({ status: 400, message: claude })).toBe("no_credit");
  expect(keyRefusalOf({ status: 403, message: "provider denied access" })).toBe("denied");
  expect(keyRefusalOf({ status: 403, message: "provider denied access (403): Country not supported" })).toBe("denied");
  expect(keyRefusalOf({ status: 403, message: "provider denied access (403): no access to model x" })).toBeNull();
});

test("what says nothing of the key leaves it unchecked", () => {
  expect(keyRefusalOf({ status: 429, message: "rate limited by provider" })).toBeNull();
  expect(keyRefusalOf({ status: 500, message: "provider error" })).toBeNull();
  expect(keyRefusalOf({ message: "could not reach provider" })).toBeNull();
  expect(
    keyRefusalOf({ status: 403, message: "provider rejected the request (403): this model isn't yours" }),
  ).toBeNull();
});

test("the provider's words come out of a failure's shape", () => {
  expect(keyFailureWords("provider rejected the request (400 x): Add credit.")).toBe("Add credit.");
  expect(keyFailureWords("invalid provider API key")).toBe("");
});

test("the call is the provider's cheapest, a few tokens long", () => {
  const signal = new AbortController().signal;
  expect(keyCheckRequest("openai", signal)).toMatchObject({
    model: cheapModelOf("openai"),
    maxTokens: 16,
    effort: "none",
  });
  expect(keyCheckRequest("nobody", signal)).toBeNull();
});
