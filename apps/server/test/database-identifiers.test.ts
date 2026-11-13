import { expect, test } from "bun:test";
import { identPath, parseIdentPath, tableRuleNames } from "@agenteschat/engine";
import * as app from "../../../packages/client/src/lib/databases";

const SAMPLES = [
  "customers.cpf",
  "Public.Customers.CPF",
  'dbo.clientes."CPF/CNPJ Emitente"',
  ' dbo . "a.b" . "Say ""hi"""',
  "dbo.invoices.tax id/number",
  'dbo."open',
  "a.b.c.d",
  "a..b",
  'dbo.t.my"col',
  "dbo.t.tel. celular",
  "",
];

test("rule names: the engine and the apps parse and write them the same way", () => {
  for (const s of SAMPLES) {
    expect(app.parseIdentPath(s, 3)).toEqual(parseIdentPath(s, 3));
    expect(app.parseIdentPath(s, 2)).toEqual(parseIdentPath(s, 2));
  }
  expect(app.identPath(["dbo", "Clientes", 'x"y'])).toBe(identPath(["dbo", "Clientes", 'x"y']));
  for (const [s, t] of [
    ["dbo", "ClientesNFSe"],
    ["dbo", "My Table"],
    ["public", "orders"],
  ] as const)
    expect(app.tableRuleNames(s, t)).toEqual(tableRuleNames(s, t));
  expect(app.tableRuleNames("dbo", "ClientesNFSe")).toEqual(['dbo."ClientesNFSe"', "dbo.clientesnfse"]);
});

test("typed hidden columns: quoted names keep their spaces and commas", () => {
  expect(app.splitColumns('clientes."CPF/CNPJ Emitente", users.Password_Hash; "Bad"')).toEqual({
    valid: ['public.clientes."CPF/CNPJ Emitente"', "public.users.password_hash"],
    invalid: ['"Bad"'],
  });
});
