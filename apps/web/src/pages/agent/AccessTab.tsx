import { useAgentSkills } from "@agenteschat/client";
import { type AccessResource, asksAt, type Level, sharedLevel } from "@agenteschat/client/lib/access-levels";
import { modeKey } from "@agenteschat/client/lib/workspace-mode";
import { Button, Card, Chip, EmptyState, Icon, SearchField, Segmented, Toolbar } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  LevelRow,
  levelText,
  NoConnectors,
  ResourceIcon,
  resourceName,
  toolLabel,
  useConnectedById,
} from "@/components/AccessLevels";
import { LoadingLine } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { SkillPicker } from "@/components/Skills";
import { lookOf } from "@/lib/look";
import { ApprovalRulesCard } from "./ApprovalRulesCard";
import { CardHead, ChangedTag, useAgentEdit, WasLine } from "./context";
import { DatabaseAccessCard } from "./DatabaseAccess";
import { MailAccessCard } from "./MailAccess";
import { ReadOnlyNote } from "./pieces";
import { MergeReposBlock, ReposBlock } from "./Repos";

type AccessFilter = "all" | "on" | "ask";

/**
 * Ferramentas e acesso: one level per connector and built-in area, and the skills. Saved with the save bar. In a
 * personal workspace (ADR 0159 §3) it comes in two parts: `basic` (its apps and mailboxes, the "Can use" tab) and
 * `advanced` (built-in areas, databases, rules and skills, in the Advanced tab).
 */
export function AccessTab({ part = "all" }: { part?: "all" | "basic" | "advanced" }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const { agent, g, viewer, draft, setLevel, set, can, changeOf, resources, accessState, ownerFirst } = useAgentEdit();
  const items = useConnectedById();
  const skills = useAgentSkills(org.id, agent.id);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<AccessFilter>("all");
  const editable = can("levels");
  const level = (r: AccessResource) => draft.levels[r.id] ?? "none";
  const isGithub = (r: AccessResource) => r.kind === "connector" && r.connector === "github";
  const asksOf = (r: AccessResource) => asksAt(r, level(r)).map((x) => toolLabel(t, r, x));
  const needle = q.trim().toLowerCase();
  const shown = resources.filter((r) => {
    if (needle && !resourceName(t, r, items).toLowerCase().includes(needle)) return false;
    if (filter === "on") return level(r) !== "none";
    if (filter === "ask") return asksOf(r).length > 0;
    return true;
  });
  const count = {
    all: resources.length,
    on: resources.filter((r) => level(r) !== "none").length,
    ask: resources.filter((r) => asksOf(r).length > 0).length,
  };
  const connectors = shown.filter((r) => r.kind === "connector");
  const noConnectors = resources.every((r) => r.kind !== "connector");
  const builtins = shown.filter((r) => r.kind === "builtin");
  const row = (r: AccessResource) => {
    const name = resourceName(t, r, items);
    const key = `levels:${r.id}`;
    const changed = Boolean(changeOf(key));
    return (
      <LevelRow
        key={r.id}
        icon={<ResourceIcon resource={r} items={items} name={name} />}
        name={name}
        description={levelText(t, r, level(r), g)}
        asks={asksOf(r)}
        levels={r.levels}
        value={level(r)}
        onChange={editable ? (l) => setLevel(r.id, l) : undefined}
        changed={changed || (isGithub(r) && Boolean(changeOf("repos")))}
        tag={changed ? <ChangedTag changeKey={key} /> : undefined}
        extra={changed ? <WasLine changeKey={key} /> : undefined}
        below={
          isGithub(r) && level(r) !== "none" ? (
            <>
              <ReposBlock />
              <MergeReposBlock />
            </>
          ) : undefined
        }
      />
    );
  };
  const empty = (
    <EmptyState
      size="inline"
      actions={
        <Button
          size="sm"
          onClick={() => {
            setQ("");
            setFilter("all");
          }}
        >
          {t("filters.clearAll")}
        </Button>
      }
    >
      {needle ? t("agentPage.access.noMatch", { q }) : t("agentPage.access.noneHere")}
    </EmptyState>
  );
  const allConnectors = (l: Level) => {
    for (const r of resources) if (r.kind === "connector" && r.levels.includes(l)) setLevel(r.id, l);
  };
  const library = skills.data ?? [];
  const enabled = new Set(draft.skills ?? []);
  const skillsEditable = can("skills") && draft.skills !== undefined;
  const basic = part !== "advanced";
  const advanced = part !== "basic";
  return (
    <>
      {basic && <ReadOnlyNote field="levels" />}
      {part === "all" && (
        <Toolbar
          size="sm"
          search={
            <SearchField
              size="sm"
              aria-label={t("agentPage.access.search")}
              placeholder={t("agentPage.access.search")}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onClear={() => setQ("")}
              clearLabel={t("filters.clearSearch")}
            />
          }
        >
          <Segmented
            size="sm"
            label={t("agentPage.access.filter")}
            value={filter}
            onValueChange={setFilter}
            options={(["all", "on", "ask"] as const).map((f) => ({
              value: f,
              label: t(`agentPage.access.filters.${f}`),
              count: count[f],
            }))}
          />
        </Toolbar>
      )}
      <div className="agp-cols">
        <div className="agp-col">
          {accessState === "loading" ? (
            <Card className="agp-card">
              <LoadingLine width={260} />
            </Card>
          ) : accessState === "unavailable" ? (
            <Card className="agp-card">
              <span className="muted">{t("access.unavailable")}</span>
            </Card>
          ) : (
            <>
              {basic && (
                <Card as="section" className="agp-card" aria-labelledby="ac-connectors">
                  <CardHead
                    id="ac-connectors"
                    icon="plug"
                    title={t(modeKey(org, "agentPage.access.connectors"), { org: org.name })}
                    action={<span className="small muted">{t("agentPage.access.oneLevel")}</span>}
                  />
                  {editable && resources.some((r) => r.kind === "connector") && (
                    // Every connector at once acts on this card's list: one control over it, from the rows' own edge.
                    <div className="newag__list-head">
                      <span className="newag__quick">
                        {t("agentPage.access.allConnectors")}
                        <Segmented
                          size="sm"
                          label={t("access.kind.connectors")}
                          value={sharedLevel(resources.filter((r) => r.kind === "connector").map(level)) ?? "custom"}
                          onValueChange={(l) => l !== "custom" && allConnectors(l)}
                          options={[
                            { value: "none", label: t("access.level.none") },
                            { value: "read", label: t("agentPage.access.onlyRead") },
                            { value: "write", label: t("access.level.write") },
                          ]}
                        />
                      </span>
                    </div>
                  )}
                  {noConnectors ? (
                    <NoConnectors look={lookOf(agent) ?? true} />
                  ) : connectors.length ? (
                    <ul className="level-list" aria-label={t("access.kind.connectors")}>
                      {connectors.map(row)}
                    </ul>
                  ) : (
                    empty
                  )}
                  {viewer === "admin" && !needle && !noConnectors && (
                    <Link
                      className="newag__addrow"
                      to="/org/$orgId/settings/$section"
                      params={{ orgId: org.id, section: "connectors" }}
                    >
                      <Icon name="plug" />
                      {t("newAgent.connectOther")}
                      <span className="newag__addrow-aside">{t("newAgent.opensConnectors")}</span>
                    </Link>
                  )}
                </Card>
              )}
              {basic && <MailAccessCard />}
              {advanced && <DatabaseAccessCard />}
              {advanced && (
                <Card as="section" className="agp-card" aria-labelledby="ac-builtin">
                  <CardHead
                    id="ac-builtin"
                    icon="agent"
                    title={t("agentPage.access.builtin")}
                    action={<span className="small muted">{t("agentPage.access.builtinHelp")}</span>}
                  />
                  {builtins.length ? (
                    <ul className="level-list" aria-label={t("access.kind.builtin")}>
                      {builtins.map(row)}
                    </ul>
                  ) : (
                    empty
                  )}
                </Card>
              )}
            </>
          )}
        </div>
        <div className="agp-col">
          {advanced && resources.some(isGithub) && (
            <p className="newag__note ac-iconline">
              <Icon name="repo" size={16} />
              <span>
                <b>{t("repos.realTitle")}</b> {t("repos.realText", g)}
              </span>
            </p>
          )}
          <p className="newag__note ac-iconline">
            <Icon name="shield" size={16} />
            <span>
              <b>{t("newAgent.approvalsNote")}</b>{" "}
              {ownerFirst ? t("newAgent.approverOwner", { name: ownerFirst }) : t("newAgent.approverAdmins")}
            </span>
          </p>
          {advanced && <ApprovalRulesCard />}
          {advanced && (
            <Card
              as="section"
              className="agp-card"
              data-changed={changeOf("skills") ? true : undefined}
              aria-labelledby="ac-skills"
            >
              <CardHead
                id="ac-skills"
                icon="book"
                title={t("skills.agentTitle")}
                changeKeys={["skills"]}
                lock="skills"
              />
              <span className="small muted">{t("newAgent.skillsHelp", g)}</span>
              {skills.isLoading ? (
                <LoadingLine width={200} />
              ) : skills.isError ? (
                <span className="muted">{t("skills.unavailable")}</span>
              ) : library.length === 0 ? (
                <EmptyState
                  size="panel"
                  agent={lookOf(agent) ?? true}
                  title={t("skills.emptyTitle")}
                  actions={
                    viewer === "admin" && (
                      <Button asChild variant="primary" icon="plus">
                        <Link to="/org/$orgId/settings/$section" params={{ orgId: org.id, section: "skills" }}>
                          {t("skills.install")}
                        </Link>
                      </Button>
                    )
                  }
                >
                  {t("skills.emptyText")}
                </EmptyState>
              ) : skillsEditable ? (
                <SkillPicker
                  skills={library}
                  selected={enabled}
                  onChange={(next) => set("skills", [...next].sort())}
                  idPrefix="agp-skill"
                />
              ) : enabled.size > 0 ? (
                <span className="agp-chips">
                  {library
                    .filter((s) => enabled.has(s.id))
                    .map((s) => (
                      <Chip key={s.id} icon="book">
                        {s.name}
                      </Chip>
                    ))}
                </span>
              ) : (
                <span className="small muted">{t("skills.agentEmpty", { name: agent.name })}</span>
              )}
              <WasLine changeKey="skills" />
              {viewer === "admin" && library.length > 0 && (
                <Link
                  className="agp-more"
                  to="/org/$orgId/settings/$section"
                  params={{ orgId: org.id, section: "skills" }}
                >
                  <Icon name="book" size={14} />
                  {t("agentPage.access.library")}
                </Link>
              )}
            </Card>
          )}
          {advanced && (
            <p className="newag__note ac-iconline">
              <Icon name="info" size={16} />
              <span>{t("agentPage.access.fineTune")}</span>
            </p>
          )}
        </div>
      </div>
    </>
  );
}
