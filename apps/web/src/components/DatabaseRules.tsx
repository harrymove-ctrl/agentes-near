import type { DatabaseConnection, DatabasePolicy } from "@agenteschat/client";
import { useDatabaseTables, useServerDatabases } from "@agenteschat/client";
import { DATABASE_TIMEOUTS, splitColumns, splitDatabaseNames, tableRuleNames } from "@agenteschat/client/lib/databases";
import { CheckboxPill, Field, Input, Segmented } from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AddressList } from "@/components/AddressList";
import { useOrg } from "@/components/org-context";

/**
 * The rules for one database (ADR 0039), in the email rules' shape: tables
 * (none = all), hidden columns, a daily cap and the time limit per query.
 * A whole-server connection adds which of its databases (none = all); the
 * rest applies to each, with the tables read from the sample database.
 */
export function DatabaseRulesPanel({
  connection,
  policy,
  onChange,
  disabled,
}: {
  connection: DatabaseConnection;
  policy: DatabasePolicy;
  onChange: (policy: DatabasePolicy) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const connectionId = connection.id;
  const whole = connection.wholeServer;
  const tables = useDatabaseTables(org.id, connectionId);
  const names = useServerDatabases(org.id, connectionId, whole);
  const [some, setSome] = useState((policy.databases?.length ?? 0) > 0);
  const set = (next: Partial<DatabasePolicy>) => onChange({ ...policy, ...next });
  const id = (name: string) => `db-${name}-${connectionId}`;
  const numberOrNull = (v: string) => {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  return (
    <div className="mail-rules__body">
      <section className="mail-rules__part" aria-labelledby={id("read-h")}>
        <h4 id={id("read-h")} className="mail-rules__h">
          {t("database.rulesRead")}
        </h4>
        {whole && (
          <div className="ac-field">
            <span className="ac-field__label">{t("database.rule.databases")}</span>
            <Segmented
              label={t("database.rule.databases")}
              value={some ? "some" : "all"}
              onValueChange={(v) => {
                if (disabled) return;
                setSome(v === "some");
                if (v === "all") set({ databases: undefined });
              }}
              options={[
                { value: "all", label: t("database.rule.databasesAll") },
                { value: "some", label: t("database.rule.databasesSome") },
              ]}
            />
            {some && (
              <AddressList
                id={id("databases")}
                label={t("database.rule.databasesSome")}
                values={policy.databases ?? []}
                onChange={(databases) => set({ databases })}
                disabled={disabled}
                split={splitDatabaseNames}
                suggestions={names.data}
                clearable
                inputMode="text"
                placeholder={t("database.rule.databasePlaceholder")}
              />
            )}
            <span className="ac-field__example">{t("database.rule.databasesHelp")}</span>
          </div>
        )}
        <fieldset className="mail-rules__group">
          <legend className="ac-field__label">
            {whole ? t("database.rule.tablesIn", { database: connection.database }) : t("database.rule.tables")}
          </legend>
          {tables.isLoading ? (
            <span className="small muted">{t("database.rule.tablesLoading")}</span>
          ) : tables.isError ? (
            <span className="small muted">{t("database.rule.tablesError")}</span>
          ) : (
            <div className="newag__pills">
              {(tables.data ?? []).map((table) => {
                const names = tableRuleNames(table.schema, table.name);
                const name = names[0] ?? "";
                const others = policy.tables.filter((x) => !names.includes(x));
                return (
                  <CheckboxPill
                    key={name}
                    id={id(`table-${name}`)}
                    disabled={disabled}
                    checked={others.length < policy.tables.length}
                    onCheckedChange={(on) => set({ tables: on ? [...others, name] : others })}
                  >
                    {table.schema === "public" ? table.name : `${table.schema}.${table.name}`}
                  </CheckboxPill>
                );
              })}
            </div>
          )}
          <span className="small muted">{t("database.rule.tablesHelp")}</span>
        </fieldset>
        <AddressList
          id={id("hidden")}
          label={t("database.rule.hidden")}
          example={t("database.rule.hiddenHelp")}
          values={policy.hiddenColumns}
          onChange={(hiddenColumns) => set({ hiddenColumns })}
          disabled={disabled}
          split={splitColumns}
          clearable
          inputMode="text"
          placeholder={t("database.rule.hiddenPlaceholder")}
          invalidText={t("database.rule.hiddenInvalid")}
        />
      </section>
      <section className="mail-rules__part" aria-labelledby={id("limits-h")}>
        <h4 id={id("limits-h")} className="mail-rules__h">
          {t("database.rulesLimits")}
        </h4>
        <Field
          label={t("database.rule.cap")}
          id={id("cap")}
          example={whole ? t("database.rule.capHelpAll") : t("database.rule.capHelp")}
        >
          <Input
            className="ac-num mail-rules__cap"
            type="number"
            min={1}
            inputMode="numeric"
            disabled={disabled}
            value={policy.dailyQueryCap ?? ""}
            onChange={(e) => set({ dailyQueryCap: numberOrNull(e.target.value) })}
          />
        </Field>
        <Field
          label={t("database.rule.timeout")}
          group
          hint={{
            name: t("common.about", { label: t("database.rule.timeout") }),
            text: t("database.rule.timeoutHelp"),
          }}
        >
          <Segmented
            label={t("database.rule.timeout")}
            value={String(policy.timeoutSeconds)}
            onValueChange={(v) => !disabled && set({ timeoutSeconds: Number(v) })}
            options={DATABASE_TIMEOUTS.map((s) => ({
              value: String(s),
              label: t("database.rule.seconds", { count: s }),
            }))}
          />
        </Field>
      </section>
    </div>
  );
}
