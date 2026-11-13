import { describe, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { act, fireEvent, render, within } from "@testing-library/react";
import {
  Button,
  Field,
  FilterBar,
  FilterChip,
  GroupHeading,
  Input,
  SearchField,
  Segmented,
  SettingRow,
  Switch,
  Toolbar,
} from "../src";

const body = () => within(document.body);

/**
 * The worst realistic data through the same props the pages pass: CI's geometry check lays these screens out at 1280,
 * 320 and 390 (the capture preload saves them), so a rule broken by a long value or a big count fails there.
 */
describe("worst cases", () => {
  test("a long group title with a big count and its link, Japanese beside it, a group of one", () => {
    const { container } = render(
      <div className="ac-groups">
        <section>
          <GroupHeading
            title="Relatórios de campanha da Northwind Industries Holdings"
            count="1.284"
            aside={<a href="#historico">Ver histórico</a>}
          />
          <div className="ac-list">
            <div className="ac-list__row">Relatório de campanha: Black Friday 2026, segunda rodada de testes A/B</div>
          </div>
        </section>
        <section>
          <GroupHeading title="今日の承認待ち" count={1} />
          <div className="ac-list">
            <div className="ac-list__row">週次サマリー</div>
          </div>
        </section>
      </div>,
    );
    expect([...container.querySelectorAll(".ac-grouphead__count")].map((c) => c.textContent)).toEqual(["1.284", "1"]);
  });

  test("a toolbar whose filters hold long values, with a view switch and an action", () => {
    // In a page's room, as every toolbar is: the filters' row reaches 4px past the toolbar to keep its rings whole.
    const { container } = render(
      <div className="page">
        <Toolbar
          search={<SearchField aria-label="Buscar arquivos" placeholder="Buscar arquivos" />}
          actions={
            <>
              <Segmented
                size="sm"
                label="Ver como"
                value="grid"
                onValueChange={() => {}}
                options={[
                  { value: "grid", label: "Grade" },
                  { value: "list", label: "Lista" },
                ]}
              />
              <Button size="sm">Novo documento</Button>
            </>
          }
        >
          <FilterBar
            label="Filtros"
            clearText="Limpar filtros"
            onClear={() => {}}
            filters={[
              {
                key: "channel",
                active: true,
                node: (
                  <FilterChip
                    label="Canal"
                    icon="channel"
                    clearLabel="Limpar Canal"
                    value={["c"]}
                    onChange={() => {}}
                    valueText={(o) => o.label}
                    options={[{ value: "c", label: "#lancamento-campanha-black-friday-2026" }]}
                  />
                ),
              },
              {
                key: "who",
                active: true,
                node: (
                  <FilterChip
                    label="Pessoa ou agente"
                    icon="person"
                    clearLabel="Limpar Pessoa ou agente"
                    value={["a"]}
                    onChange={() => {}}
                    options={[{ value: "a", label: "Aleksandra Wiśniewska-Kowalczyk" }]}
                  />
                ),
              },
              {
                key: "kind",
                active: false,
                node: (
                  <FilterChip
                    label="Tipo"
                    icon="file"
                    clearLabel="Limpar Tipo"
                    multiple
                    value={[]}
                    onChange={() => {}}
                    options={[{ value: "docs", label: "Documentos", count: 3 }]}
                  />
                ),
              },
            ]}
          />
        </Toolbar>
      </div>,
    );
    expect(container.querySelectorAll(".ac-filter--active")).toHaveLength(2);
  });

  test("Tipo open: every kind with its count, a huge one, a single one, a long name and Japanese", async () => {
    render(
      <FilterChip
        label="Tipo"
        icon="file"
        clearLabel="Limpar Tipo"
        multiple
        value={["code", "sheets"]}
        onChange={() => {}}
        countText={(n) => `${n} tipos`}
        options={[
          { value: "docs", label: "Documentos", count: 1284 },
          { value: "code", label: "Alterações de código em revisão", count: 1 },
          { value: "pages", label: "Páginas HTML", count: 12 },
          { value: "sheets", label: "スプレッドシート", count: 7 },
        ]}
      />,
    );
    await act(async () => fireEvent.click(body().getByRole("button", { name: "2 tipos" })));
    expect(within(body().getByRole("listbox", { name: "Tipo" })).getAllByRole("option")).toHaveLength(4);
  });

  test("settings rows with long titles, a long status, Japanese and an example that can't break", () => {
    const { container } = render(
      <div className="ac-card">
        <SettingRow
          title="Avisar quando um agente pedir aprovação fora do horário de trabalho"
          hint={{
            name: "Sobre Avisar quando um agente pedir aprovação",
            text: "Um aviso no celular e no email, mesmo com o app fechado.",
          }}
          status="Desligado pelos admins do workspace até a revisão de segurança terminar."
        >
          <Switch checked={false} onCheckedChange={() => {}} aria-label="Avisar fora do horário" />
        </SettingRow>
        <SettingRow
          title="週次サマリーをメールで受け取る"
          hint={{ name: "週次サマリーについて", text: "毎週月曜日に届きます。" }}
        >
          <Switch checked onCheckedChange={() => {}} aria-label="週次サマリー" />
        </SettingRow>
        <Field
          label="Endereço do webhook de eventos da campanha"
          hint={{ name: "Sobre Endereço do webhook", text: "Recebe um aviso a cada tarefa concluída." }}
          example="ex.: https://hooks.northwind-industries-holdings.example.com/agentes/v2/eventos/campanha"
        >
          <Input />
        </Field>
      </div>,
    );
    expect(container.querySelectorAll(".ac-setrow")).toHaveLength(2);
  });
});
