import { expect, test } from "bun:test";
import { mailDetail, parseMailDetail, withoutReplyPrefix } from "../src";

test("a mail approval's detail reads back as the email it writes", () => {
  const preview = {
    from: "support@acme.com",
    to: ["ana@acme.com", "bia@acme.com"],
    cc: ["boss@acme.com"],
    bcc: [],
    subject: "Re: Question: a long one",
    body: "Hi Ana,\n\nThanks!\n\nSupport",
    original: { subject: "Question: a long one", from: "ana@acme.com" },
  };
  expect(parseMailDetail(mailDetail(preview))).toEqual(preview);
  expect(parseMailDetail(mailDetail({ ...preview, cc: [], original: null }))).toEqual({
    ...preview,
    cc: [],
    original: null,
  });
  // A sender nobody read stays unknown.
  expect(parseMailDetail(mailDetail({ ...preview, original: { subject: "Question", from: null } }))?.original).toEqual({
    subject: "Question",
    from: null,
  });
});

test("other details aren't read as an email", () => {
  expect(parseMailDetail('{"body":"Hi","subject":"Hello"}')).toBeNull();
  expect(parseMailDetail("Moves the message to the trash of support@acme.com.")).toBeNull();
  expect(parseMailDetail("")).toBeNull();
});

test("the answered subject drops its reply prefixes", () => {
  expect(withoutReplyPrefix("Re: RE: Question")).toBe("Question");
  expect(withoutReplyPrefix("Fwd: Res: Pedido")).toBe("Pedido");
  expect(withoutReplyPrefix("Rental")).toBe("Rental");
});
