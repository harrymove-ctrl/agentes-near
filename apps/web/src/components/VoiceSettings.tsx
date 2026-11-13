import type { SpeechKey, SpeechProvider } from "@agenteschat/client";
import {
  useRemoveSpeechKey,
  useSaveSpeechKey,
  useSettings,
  useSpeechKey,
  useUpdateSettings,
} from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { can } from "@agenteschat/client/lib/permissions";
import {
  Button,
  Card,
  Chip,
  Icon,
  Input,
  Locked,
  ProviderLogo,
  Radio,
  RadioGroup,
  SettingNote,
  Switch,
} from "@agenteschat/ui";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { ErrorState, LoadingList } from "@/components/Loading";
import { PrefRow } from "@/components/NoticePrefs";
import { useOrg } from "@/components/org-context";

/** Who can be chosen, in the order the list shows them. Their names are the providers' own. */
const PROVIDERS: { id: SpeechProvider; name: string }[] = [
  { id: "assemblyai", name: "AssemblyAI" },
  { id: "elevenlabs", name: "ElevenLabs" },
  { id: "soniox", name: "Soniox" },
  { id: "groq", name: "Groq" },
  { id: "openai", name: "OpenAI" },
  { id: "deepinfra", name: "DeepInfra" },
];

/** Configurações › Voz (ADR 0100). Who configures the workspace changes it; everyone else reads it. */
export function VoiceSettingsSection() {
  const { org } = useOrg();
  const settings = useSettings(org.id);
  const update = useUpdateSettings(org.id);
  const editable = can(org, "configure");
  if (!settings.data) {
    return settings.isError ? (
      <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />
    ) : (
      <LoadingList count={1} avatar={false} trailing />
    );
  }
  const on = (update.isPending ? update.variables?.voiceMessages : undefined) ?? settings.data.voiceMessages;
  return (
    <VoiceSettingsCard
      on={on}
      available={settings.data.voiceAvailable}
      editable={editable}
      onChange={(voiceMessages) => {
        if (editable) update.mutate({ voiceMessages });
      }}
    />
  );
}

/**
 * The card of Configurações › Voz (ADR 0100): the workspace's switch, and on a server that isn't agentes.chat's own, for
 * its owner, who turns voice into text (the API answers null to everyone else). A key is tried with the provider
 * before it is kept, sealed on the server and never shown again.
 */
export function VoiceSettingsCard({
  on,
  available,
  editable,
  onChange,
}: {
  on: boolean;
  available: boolean;
  editable: boolean;
  onChange: (next: boolean) => void;
}) {
  const { t } = useTranslation();
  const view = useSpeechKey().data;
  return (
    <Card aria-label={t("voice.settings.title")}>
      <div className="settings-rows">
        <PrefRow
          id="media-voice-on"
          icon="mic"
          label={t("voice.settings.on")}
          hint={available ? t("voice.settings.onHelp") : undefined}
          status={!available && t("voice.settings.noEngine")}
          control={
            <Switch
              checked={available && on}
              onCheckedChange={onChange}
              disabled={!editable || !available}
              aria-label={t("voice.settings.on")}
            />
          }
        />
      </div>
      {view && <SpeechProviderPicker view={view} />}
    </Card>
  );
}

function SpeechProviderPicker({ view }: { view: SpeechKey }) {
  const { t } = useTranslation();
  const save = useSaveSpeechKey();
  const remove = useRemoveSpeechKey();
  const [provider, setProvider] = useState<SpeechProvider>(view.provider ?? "assemblyai");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [tested, setTested] = useState(false);
  const field = useId();
  const local = provider === "local";
  const name = PROVIDERS.find((p) => p.id === provider)?.name ?? "";
  const pick = (next: string) => {
    setProvider(next as SpeechProvider);
    setValue("");
    setError(null);
    setTested(false);
  };
  const test = () => {
    setError(null);
    setTested(false);
    const typed = value.trim();
    save.mutate(local ? { provider, baseUrl: typed } : { provider, apiKey: typed }, {
      onSuccess: () => {
        setValue("");
        setTested(true);
      },
      onError: (e) => setError(errorText(t, e)),
    });
  };
  return (
    <div className="voice-engine">
      <div className="voice-engine__body">
        <h3 className="voice-engine__title">{t("voice.settings.engineTitle")}</h3>
        <Locked when={save.isPending || remove.isPending}>
          <RadioGroup
            className="voice-engine__tiles"
            value={provider}
            onValueChange={pick}
            aria-label={t("voice.settings.engineTitle")}
          >
            {PROVIDERS.map((p) => (
              // biome-ignore lint/a11y/noLabelWithoutControl: the Radio inside is its control
              <label key={p.id} className="voice-tile">
                <Radio className="voice-tile__radio" value={p.id} aria-label={p.name} />
                <ProviderLogo id={p.id} size="sm" />
                <span className="voice-tile__name">{p.name}</span>
                <span className="voice-tile__check" aria-hidden="true">
                  <Icon name="check" size={14} />
                </span>
              </label>
            ))}
            {/* biome-ignore lint/a11y/noLabelWithoutControl: the Radio inside is its control */}
            <label className="voice-tile">
              <Radio className="voice-tile__radio" value="local" aria-label={t("voice.settings.own")} />
              <span className="voice-tile__own" aria-hidden="true">
                <Icon name="computer" size={16} />
              </span>
              <span className="voice-tile__name">{t("voice.settings.own")}</span>
              <span className="voice-tile__check" aria-hidden="true">
                <Icon name="check" size={14} />
              </span>
            </label>
          </RadioGroup>
          <label className="voice-engine__label" htmlFor={field}>
            {local ? t("voice.settings.address") : t("voice.settings.key", { name })}
          </label>
          <span className="voice-engine__field">
            <Input
              id={field}
              type={local ? "text" : "password"}
              value={value}
              autoComplete="off"
              spellCheck={false}
              placeholder={local ? "http://speech:8000/v1" : t("voice.settings.keyPlaceholder")}
              invalid={Boolean(error)}
              onChange={(e) => {
                setValue(e.target.value);
                setError(null);
                setTested(false);
              }}
            />
            <Button disabled={!value.trim()} loading={save.isPending} onClick={test}>
              {t("voice.settings.test")}
            </Button>
          </span>
        </Locked>
        {error ? (
          <p className="ac-field__error">{error}</p>
        ) : tested ? (
          <SettingNote icon="check">{t("voice.settings.tested")}</SettingNote>
        ) : (
          <p className="ac-field__example">{local ? t("voice.settings.ownHelp") : t("voice.settings.sealed")}</p>
        )}
        {!local && <SettingNote icon="info">{t("voice.settings.leaves", { name })}</SettingNote>}
        {view.state === "invalid" && <SettingNote icon="alert">{t("voice.settings.invalid")}</SettingNote>}
        {view.provider && (
          <span className="voice-engine__saved">
            <Chip icon="check" tone="done">
              {view.provider === "local"
                ? t("voice.settings.own")
                : (PROVIDERS.find((p) => p.id === view.provider)?.name ?? "")}
            </Chip>
            {view.hint && (
              <span className="small muted">
                {view.provider === "local" ? view.hint : t("settings.keyEndsIn", { hint: view.hint })}
              </span>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="ac-btn--danger"
              loading={remove.isPending}
              onClick={() => remove.mutate(undefined)}
            >
              {t("settings.remove")}
            </Button>
          </span>
        )}
      </div>
    </div>
  );
}
