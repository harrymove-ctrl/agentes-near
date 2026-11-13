import { addDm, keys, meQuery, useApi, useAuthConfig, useTeamTemplates, type WorkspaceMode } from "@agenteschat/client";
import { firstName } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { settingUp } from "@agenteschat/client/lib/guards";
import { landingOf, type RailStep, railState } from "@agenteschat/client/lib/onboarding";
import { can } from "@agenteschat/client/lib/permissions";
import { finishOnboarding, isRightHand, RIGHT_HAND_DEFAULT } from "@agenteschat/client/lib/right-hand";
import { aboutOf, type BusinessType, templateFor } from "@agenteschat/client/lib/team-plan";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import { useIsMutating, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal, Pressable, StyleSheet, View } from "react-native";
import { signOut } from "@/features/account";
import { agentLook } from "@/features/shared/logic";
import { authClient } from "@/lib/auth";
import { useOrgGate } from "@/providers/org";
import { Button, LineIcon, Locked, OptionTile, Text, useTheme } from "@/ui";
import { AuthField } from "@/ui/auth/AuthField";
import { AuthLink } from "@/ui/auth/AuthLink";
import { AuthScaffold, CENTER } from "@/ui/auth/AuthScaffold";
import { router } from "@/ui/navigation";
import { confirmationSentTo, forgetConfirmationSent } from "../auth/confirmation";
import { InviteCrew } from "../auth/invite-parts";
import { chatHref } from "../links/logic";
import { openWebPath } from "../links/open-web";
import { ZoneList } from "../me/AccountPage";
import { chooseAction } from "../settings/parts";
import { usePersonPhoto } from "../shared/photo";
import { orgNameFromEmail, PURPOSES, phoneTimezone, stepFailedText, workspaceAnswer, zoneLabel } from "./logic";
import { PurposeScene } from "./PurposeScene";
import { BusinessStep, PlanStep, TeamStep } from "./steps";

/**
 * The first run on the phone, signed in with no workspace to open yet (ADR 0162), the web's steps on the sign-in's own
 * screen. First what the workspace is for (ADR 0159), two cards and Continue: "For me" makes a personal workspace at
 * once, named in the person's language with the phone's time zone, and opens it in its right hand's DM, where its card
 * holds the rest. A company or team goes on: the workspace's name (its time zone from the phone, said in one line; its
 * logo later, in Configurações), the keyboard's return key as the action; what it does; its team, made from a
 * template; and, on agentes.chat Cloud, the plan it waits for, in words only. Its right hand stands on the sky and says
 * one line per step, the team joining it there once picked. The step is read from the workspace's data, so one left at
 * any step (here or on the web) resumes there, never a second one. It opens in #general, or in the right hand's DM
 * when the plan was left for the web.
 * Nothing destructive lives here: leaving the account is a quiet line, deleting it stays on the website. `onLeave`:
 * opened over a workspace being deleted, or from Adicionar workspace (ADR 0154), its first step goes back there;
 * `another`: the name of the workspace the person is still in meanwhile.
 */
export function OnboardingFlow({ onLeave, another }: { onLeave?: () => void; another?: string | null } = {}) {
  const { t, i18n } = useTranslation();
  const api = useApi();
  const qc = useQueryClient();
  const gate = useOrgGate();
  // Asked again whenever the app comes back: a plan paid on the website meanwhile opens the workspace.
  const me = useQuery({ ...meQuery(api), refetchOnWindowFocus: "always" });
  const authConfig = useAuthConfig().data;
  const { colors: c } = useTheme();
  // Made here; else the one this person is setting up (a visit cut short, here or on the web), which resumes.
  const [created, setCreated] = useState<{ orgId: string; generalChannelId: string } | null>(null);
  // What it is for (ADR 0159), asked before the workspace exists; a company or team then goes on to its name.
  const [purpose, setPurpose] = useState<WorkspaceMode | null>(null);
  const [forTeam, setForTeam] = useState(false);
  // The first question's cards, side by side: each half of the row, less the gap between them.
  const [cardsWidth, setCardsWidth] = useState(0);
  const cardWidth = cardsWidth > 0 ? (cardsWidth - CARD_GAP) / 2 : 0;
  // A done step the person went back to, else the step the data says.
  const [picked, setPicked] = useState<RailStep | null>(null);
  // What step 2 picked in this visit, and the template picked on step 3: step 3 starts on the business's.
  const [business, setBusiness] = useState<BusinessType | null>(null);
  const [template, setTemplate] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The zone the person picked here, if they did; said in one line with Trocar beside it.
  const [pickedZone, setZone] = useState<string | null>(null);
  const [pickingZone, setPickingZone] = useState(false);
  const orgName = name.trim();
  // A work address names its company: the field starts with it, selected, so typing replaces it (`suggested`).
  const [suggested, setSuggested] = useState<string | null>(null);

  const unfinished = me.data?.organizations.find(settingUp);
  const target =
    created ??
    (unfinished?.onboarding
      ? { orgId: unfinished.id, generalChannelId: unfinished.onboarding.generalChannelId }
      : null);
  const orgId = target?.orgId ?? null;
  const mine = me.data?.organizations.find((o) => o.id === orgId);
  // Asked again as the app comes back too: a step answered on the web meanwhile moves this one on, so its button never
  // makes a second team.
  const settings = useQuery({
    queryKey: keys.settings(orgId ?? ""),
    queryFn: () => api.orgs.settings(orgId ?? ""),
    enabled: orgId !== null,
    refetchOnWindowFocus: "always",
  });
  const agents = useQuery({
    queryKey: keys.agents(orgId ?? ""),
    queryFn: () => api.agents.list(orgId ?? ""),
    enabled: orgId !== null,
    refetchOnWindowFocus: "always",
  });
  const lodi = agents.data?.find(isRightHand);
  // In the order they were made (the server's), a template's team in its template's order: as every screen lists it.
  const team = (agents.data ?? []).filter((a) => !isRightHand(a));
  const context = settings.data?.context?.trim() ?? "";
  // Made here as "For me", or one being set up that is.
  const personal = isPersonal(mine) || (created !== null && purpose === "personal");
  const { steps, at, step, index } = railState({
    orgId,
    standing: mine?.standing,
    billingUrl: authConfig?.billingUrl,
    context,
    team: team.length,
    picked,
    personal,
    funnel: null,
  });
  // Before the workspace exists, what it is for comes first.
  const asking = orgId === null && !forTeam;
  // Read once is enough: a refetch that fails later keeps the step on screen with what it read.
  const known = orgId === null || (settings.data !== undefined && agents.data !== undefined && mine !== undefined);
  // Back on step 1, the workspace's own zone (saved on another visit, maybe on the web), never the phone's.
  const zone = pickedZone ?? settings.data?.timezone ?? phoneTimezone();
  const kind = business ?? aboutOf(t, context).business;
  const templates = useTeamTemplates(
    orgId ?? "",
    i18n.language,
    orgId !== null && (step === "business" || step === "team"),
  );
  const chosen = templateFor(templates.data ?? [], template, kind);
  // The right hand works while anything saves, the steps' own requests included.
  const mutating = useIsMutating();
  const working = pending || mutating > 0;

  // The address this sign-up was emailed a link to confirm (features/auth/confirmation.ts): the step says where it
  // went, until `me` says it's confirmed.
  const email = me.data?.user.email ?? "";
  // You, in the first question's drawings: the account's photo (Google's), else the initial of your name.
  const youName = me.data?.user.name || email;
  const photo = usePersonPhoto(me.data?.user.image);
  useEffect(() => {
    if (another || orgId || name !== "" || suggested !== null || !email) return;
    const guess = orgNameFromEmail(email);
    setSuggested(guess ?? "");
    if (guess) setName(guess);
  }, [another, orgId, name, suggested, email]);
  const unconfirmed =
    email !== "" && confirmationSentTo() === email.toLowerCase() && me.data?.user.emailVerified !== true;

  const run = async (work: () => Promise<void>) => {
    setPending(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(stepFailedText(t, e, i18n.language));
    } finally {
      setPending(false);
    }
  };

  /**
   * Finishes it and opens it, pushed over the tabs: #general, the right hand's DM when the plan was left for the
   * website, or the workspace's import.
   */
  const open = (how: "done" | "skipped" | "import") =>
    run(async () => {
      if (!target) return;
      const { orgId: id, generalChannelId } = target;
      const done = await finishOnboarding(api, id);
      const landing = how === "import" ? null : landingOf(how, personal);
      const dm =
        landing === "rightHand" && done.agentId
          ? await api.dms.open(id, { agentId: done.agentId }).catch(() => null)
          : null;
      forgetConfirmationSent();
      // The answer that finished it says who the person is now: nothing is asked again.
      if (done.me) qc.setQueryData(keys.me, done.me);
      else await qc.invalidateQueries({ queryKey: keys.me });
      gate.choose(id);
      // The conversation finds its DM in the lists for its header, from the open's own answer. An older self-hosted
      // server doesn't send it: the list is read again, without waiting for it.
      if (dm?.dm) addDm(qc, id, dm.dm);
      else if (dm) void qc.invalidateQueries({ queryKey: keys.dms(id) });
      if (how === "import") router.push("/settings/import");
      else router.push(chatHref(dm?.channelId ?? generalChannelId));
    });

  /** Step 1: makes the workspace (or renames it, back here later), then the next step from its data. */
  const save = () =>
    run(async () => {
      if (!orgId) {
        // "For me" asks no name: the word for it in the person's language; a company or team, the name typed.
        // Its zone, the owner's own too, in the same call.
        const res = await api.orgs.create({
          ...workspaceAnswer(t, purpose ?? "team", orgName),
          ...(zone ? { timezone: zone, memberTimezone: zone } : {}),
        });
        const id = res.organization.id;
        // The next step's data first, then the workspace among mine: it shows at once, with no wait between.
        await Promise.all([
          qc.prefetchQuery({ queryKey: keys.settings(id), queryFn: () => api.orgs.settings(id) }),
          qc.prefetchQuery({ queryKey: keys.agents(id), queryFn: () => api.agents.list(id) }),
        ]);
        if (res.me) qc.setQueryData(keys.me, res.me);
        else await qc.invalidateQueries({ queryKey: keys.me });
        setCreated({ orgId: id, generalChannelId: res.generalChannelId });
      } else {
        await api.orgs.updateSettings(orgId, { name: orgName, ...(pickedZone ? { timezone: pickedZone } : {}) });
        await qc.invalidateQueries({ queryKey: keys.me });
      }
      setPicked(null);
    });

  // Everything answered and no plan to wait for (a server of one's own, or paid on the website meanwhile): it opens.
  const opening = useRef(false);
  useEffect(() => {
    if (!known || at !== "open" || opening.current) return;
    opening.current = true;
    void open("done");
  });

  const loadFailed = settings.error ?? agents.error;
  // While it opens, the step stays on screen with its button working; a failure to open says so here.
  if (!me.data || !known || (at === "open" && error))
    return (
      <View style={[styles.screen, styles.wait, { backgroundColor: c.bg }]}>
        {error || loadFailed ? (
          <>
            <Text tone="muted" style={CENTER}>
              {error ?? stepFailedText(t, loadFailed, i18n.language)}
            </Text>
            <Button
              variant="secondary"
              size="sm"
              label={t("mobile.common.retry")}
              onPress={() => {
                opening.current = false;
                setError(null);
                if (settings.isError) void settings.refetch();
                if (agents.isError) void agents.refetch();
              }}
            />
          </>
        ) : null}
      </View>
    );

  const submit = () => {
    if (orgName && !pending) void save();
  };
  // Continue on the first question: "For me" makes the workspace now; a company or team names it first.
  const next = () => {
    if (!purpose || pending) return;
    if (purpose === "team") setForTeam(true);
    else void save();
  };

  const lodiName = lodi?.name ?? RIGHT_HAND_DEFAULT.name;
  const lodiLook = { ...agentLook(lodi ?? RIGHT_HAND_DEFAULT), id: lodi?.id ?? "right-hand" };
  const say = t(`onboarding.flow.lodi.${step}`, { first: firstName(me.data.user.name), ...agentGrammar(lodiName) });
  const workspace = (mine?.name ?? orgName).trim();
  // The team joins the right hand on the sky once it is picked, and sleeps there until its plan.
  const crew =
    step === "team" || step === "plan"
      ? [
          { id: lodiLook.id, appearance: lodiLook, ...(working ? { mode: "run" as const } : {}) },
          ...(team.length > 0 ? team : (chosen?.team.agents ?? [])).map((a) => ({
            id: a.handle,
            appearance: a.appearance,
            ...(step === "plan" ? { mode: "sleep" as const } : {}),
          })),
        ]
      : null;
  // Back to the step before; from the first, back to the workspace the person came from (one made here waits for
  // them, as on the web).
  const before = index > 0 ? steps[index - 1] : undefined;
  const onBack = pending
    ? undefined
    : before
      ? () => {
          if (before === "name") setName(mine?.name ?? name);
          setError(null);
          setPicked(before);
        }
      : orgId === null && forTeam
        ? () => setForTeam(false)
        : onLeave;
  const failedLine = error ? (
    <Text variant="small" tone="danger" accessibilityLiveRegion="polite" style={CENTER}>
      {error}
    </Text>
  ) : null;

  return (
    <AuthScaffold
      sky="low"
      progress={
        asking
          ? undefined
          : `${t("onboarding.flow.stepOf", { n: index + 1, total: steps.length })} · ${t(`onboarding.flow.steps.${step}`)}`
      }
      title={
        asking
          ? another
            ? t("mobile.onb.anotherPurpose")
            : t("onboarding.purpose.title")
          : step === "name"
            ? another
              ? t("mobile.onb.anotherTitle")
              : t("onboarding.workspace.title")
            : step === "business"
              ? t("agentSetup.firstRun.about.title", { org: workspace })
              : step === "team"
                ? t("onboarding.flow.team.title")
                : t("onboarding.flow.plan.title")
      }
      // The right hand's line for the step; the name's step says first what the e-mail suggested, or where this
      // workspace goes beside the one the person is in.
      subtitle={
        asking
          ? another
            ? t("mobile.onb.anotherLead", { org: another })
            : t("onboarding.purpose.lead")
          : step !== "name"
            ? say
            : another
              ? t("mobile.onb.anotherLead", { org: another })
              : suggested && name === suggested
                ? t("mobile.onb.suggested", { domain: email.split("@")[1] ?? "", org: suggested })
                : say
      }
      stepKey={asking ? "purpose" : step}
      // The sentence of step 2 sits under the business list.
      scrollToFocus={step === "business"}
      onBack={onBack}
      agent={lodiLook}
      agentMode={working ? "run" : "idle"}
      {...(crew ? { hero: <InviteCrew agents={crew} /> } : {})}
      // Nothing destroys on screen: until a workspace is set up this is the only screen, so the way out of the account
      // is one quiet "Sair", which offers Sair and, in red, Apagar conta in the system's list (a person must always
      // reach deleting their account, App Store 5.1.1(v); the web's first run takes it from there).
      footer={
        pending ? null : (
          <AuthLink
            label={t("mobile.org.signOut")}
            onPress={() =>
              chooseAction(
                email,
                [
                  { label: t("mobile.org.signOut"), onPress: () => void signOut() },
                  {
                    label: t("deleteAccount.menu"),
                    destructive: true,
                    onPress: () => openWebPath("/onboarding?account=delete"),
                  },
                ],
                t("mobile.common.cancel"),
              )
            }
          />
        )
      }
    >
      {asking ? (
        // The first question (ADR 0159): two cards side by side, as the web's, the picked one sunk with its check: on
        // top who would be there (you amid your agents, or a small org chart), the words under it; then Continue.
        <>
          <Locked when={pending} style={styles.purposes}>
            <View style={styles.cards} onLayout={(e) => setCardsWidth(e.nativeEvent.layout.width)}>
              {PURPOSES.map((mode) => {
                const on = purpose === mode;
                const title = t(`onboarding.purpose.${mode}`);
                const text = t(`onboarding.purpose.${mode}Text`);
                return (
                  <OptionTile
                    key={mode}
                    pressed={on}
                    label={`${title}. ${text}`}
                    style={styles.card}
                    onPress={() => {
                      setPurpose(mode);
                      setError(null);
                    }}
                  >
                    {cardWidth > 0 ? (
                      <PurposeScene kind={mode} chosen={on} width={cardWidth} you={{ name: youName, photo }} />
                    ) : null}
                    <View style={styles.words}>
                      <Text variant="subhead" tone="ink" style={styles.bold}>
                        {title}
                      </Text>
                      <Text variant="small" tone="muted">
                        {text}
                      </Text>
                      <Text variant="caption" tone="faint" style={styles.examples}>
                        {t(`onboarding.purpose.${mode}Examples`)}
                      </Text>
                    </View>
                  </OptionTile>
                );
              })}
            </View>
            <Button
              variant="primary"
              wide
              label={t("onboarding.actions.continue")}
              loading={pending}
              disabled={!purpose}
              onPress={next}
            />
          </Locked>
          {failedLine}
          {unconfirmed ? <ConfirmationNote email={email} /> : null}
        </>
      ) : step === "name" ? (
        <>
          <Locked when={pending} keepKeyboard style={{ gap: 8 }}>
            <AuthField
              // Mounted again once the suggestion lands, so its focus selects it (`selectTextOnFocus`).
              key={suggested ? "suggested" : "empty"}
              value={name}
              onChangeText={(value) => {
                setName(value);
                setError(null);
              }}
              placeholder={t("onboarding.workspace.namePlaceholder")}
              accessibilityLabel={t("onboarding.workspace.name")}
              autoCapitalize="words"
              autoCorrect={false}
              // The keyboard's blue key is the action ("continuar"); gray until a name is typed.
              returnKeyType="go"
              enablesReturnKeyAutomatically
              onSubmitEditing={submit}
              // The suggested name comes selected: one keystroke replaces it, the blue key keeps it.
              selectTextOnFocus={Boolean(suggested)}
              autoFocus
            />
          </Locked>
          {failedLine}
          {/* The keyboard's blue key is the only action, as on the sign-in; the agent above works while it saves. */}
          {zone ? (
            <Pressable
              onPress={() => setPickingZone(true)}
              disabled={pending}
              accessibilityRole="button"
              accessibilityLabel={`${t("mobile.onb.zone", { zone: zoneLabel(zone, i18n.language) })}. ${t("mobile.onb.zoneChange")}`}
              hitSlop={12}
              style={({ pressed }) => [styles.zone, pressed && styles.pressed]}
            >
              <Text variant="footnote" tone="faint" numberOfLines={1} style={styles.shrink}>
                {`${t("mobile.onb.zone", { zone: zoneLabel(zone, i18n.language) })} · `}
              </Text>
              <Text variant="footnote" tone="ink2" style={styles.bold}>
                {t("mobile.onb.zoneChange")}
              </Text>
            </Pressable>
          ) : null}
          {/* Outside the navigator (this screen covers it), so the list comes in a sheet of its own. */}
          <Modal
            visible={pickingZone}
            animationType="slide"
            presentationStyle="pageSheet"
            supportedOrientations={["portrait", "landscape"]}
            onRequestClose={() => setPickingZone(false)}
          >
            <ZoneList
              title={t("mobile.onb.zoneTitle")}
              value={zone}
              onClose={() => setPickingZone(false)}
              onPick={(picked) => {
                if (picked) setZone(picked);
                setPickingZone(false);
              }}
            />
          </Modal>
          {unconfirmed ? <ConfirmationNote email={email} /> : null}
        </>
      ) : step === "business" && orgId ? (
        <BusinessStep
          orgId={orgId}
          context={context}
          business={kind}
          onDone={(picked) => {
            // Another business starts the team step on its own template again; the same keeps the one picked.
            if (picked !== kind) setTemplate(null);
            setBusiness(picked);
            setPicked(null);
          }}
        />
      ) : step === "team" && orgId ? (
        <>
          <TeamStep
            orgId={orgId}
            team={team}
            templates={templates.data ?? []}
            chosen={chosen}
            listFailed={templates.isError}
            onRetryList={() => void templates.refetch()}
            reviewer={lodiName}
            onPick={setTemplate}
            // With no plan to wait for, the workspace opens once its team shows (the effect above).
            onContinue={() => setPicked(null)}
            onImport={() => void open("import")}
            leaving={pending}
          />
          {failedLine}
        </>
      ) : step === "plan" && orgId ? (
        <>
          <PlanStep
            orgId={orgId}
            team={team}
            mayPay={can(mine, "manage_billing")}
            leaving={pending}
            onEnter={() => void open("skipped")}
          />
          {failedLine}
        </>
      ) : null}
    </AuthScaffold>
  );
}

/**
 * The note that the sign-up's confirmation link went to the person's address, with a new link a tap away; gone once
 * `me` says the address is confirmed.
 */
function ConfirmationNote({ email }: { email: string }) {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  const [sent, setSent] = useState<"no" | "sending" | "sent" | "failed">("no");
  const resend = async () => {
    setSent("sending");
    const res = await authClient()
      .sendVerificationEmail({ email })
      .catch(() => null);
    setSent(res && !res.error ? "sent" : "failed");
  };
  return (
    <View style={styles.note} accessibilityLiveRegion="polite">
      <LineIcon name="mail" size={15} color={c.faint} variant="small" />
      <View style={styles.grow}>
        <Text variant="small" tone="muted">
          {sent === "sent" ? t("auth.newLinkSent", { email }) : t("onboarding.confirmation.sent", { email })}
        </Text>
        {sent === "sent" ? null : (
          <Pressable
            onPress={() => void resend()}
            disabled={sent === "sending"}
            accessibilityRole="button"
            // A 20-point line: 12 of slop around it reaches the 44-point target.
            hitSlop={12}
            style={({ pressed }) => [styles.linkButton, pressed ? styles.pressed : null]}
          >
            <Text variant="small" style={styles.bold}>
              {t("auth.sendNewLink")}
            </Text>
          </Pressable>
        )}
        {sent === "failed" ? (
          <Text variant="small" tone="danger">
            {t("mobile.app.failed")}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

/** Between the first question's two cards. */
const CARD_GAP = 10;

const styles = StyleSheet.create({
  screen: { flex: 1 },
  wait: { alignItems: "center", justifyContent: "center", gap: 12, padding: 24 },
  grow: { flex: 1, minWidth: 0 },
  bold: { fontWeight: "600" },
  // The first question's cards, then Continue under them on the same rhythm.
  purposes: { gap: 12 },
  cards: { flexDirection: "row", gap: CARD_GAP, alignItems: "stretch" },
  // Edge to edge for the drawing; the words keep the card's own padding.
  card: { flex: 1, padding: 0, overflow: "hidden" },
  words: { paddingHorizontal: 12, paddingTop: 8, paddingBottom: 12, gap: 2 },
  examples: { marginTop: 6 },
  note: { flexDirection: "row", alignItems: "flex-start", gap: 8, paddingTop: 8 },
  zone: { flexDirection: "row", alignItems: "center", justifyContent: "center", paddingTop: 8, maxWidth: "100%" },
  shrink: { flexShrink: 1 },
  linkButton: { alignSelf: "flex-start", marginTop: 2 },
  pressed: { opacity: 0.6 },
});
