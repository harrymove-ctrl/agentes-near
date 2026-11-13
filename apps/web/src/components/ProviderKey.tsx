import { CUSTOM_PROVIDER } from "@agenteschat/client/lib/endpoints";
import type { keyRefusal } from "@agenteschat/client/lib/errors";
import { PROVIDERS, type ProviderId, providerOf, providersForKey } from "@agenteschat/client/lib/providers";
import { Button, ProviderLogo, SearchSelect, type SearchSelectProps, SettingNote } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";

/** One provider from a list, by its logo and name, with a search: every AI picker's select. */
export function ProviderSelect<V extends string>(props: Omit<SearchSelectProps<V>, "labels" | "renderValue">) {
  const { t } = useTranslation();
  return (
    <SearchSelect
      {...props}
      labels={{
        search: t("connectAi.pick.search"),
        searchPlaceholder: t("connectAi.pick.searchPlaceholder"),
        noResults: t("connectAi.pick.noResults"),
        list: t("connectAi.pick.list"),
      }}
      renderValue={(o) =>
        o ? (
          <span className="row">
            {o.leading}
            {o.label}
          </span>
        ) : (
          props.placeholder
        )
      }
    />
  );
}

/** Whose API key: the makers, the most used first, then "Outro provedor" (ADR 0146). */
export function ProviderKeySelect({
  value,
  onChange,
  id,
  disabled,
}: {
  value: ProviderId | typeof CUSTOM_PROVIDER;
  onChange: (provider: ProviderId | typeof CUSTOM_PROVIDER) => void;
  id?: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <ProviderSelect<ProviderId | typeof CUSTOM_PROVIDER>
      aria-label={t("settings.provider")}
      value={value}
      onValueChange={onChange}
      {...(id ? { id } : {})}
      {...(disabled ? { disabled } : {})}
      options={[
        ...PROVIDERS.map((p) => ({ value: p.id, label: p.label, leading: <ProviderLogo id={p.id} size="xs" /> })),
        {
          value: CUSTOM_PROVIDER,
          label: t("endpoint.option"),
          description: t("endpoint.optionSub"),
          leading: <ProviderLogo id={CUSTOM_PROVIDER} size="xs" />,
        },
      ]}
    />
  );
}

/**
 * Under a key field: where to create the provider's key, then for one that also sells coding plans not to use
 * that, for one whose free tier may use what is sent to turn on billing, and for a router who may keep it.
 */
export function KeySite({ provider }: { provider: ProviderId }) {
  const { t } = useTranslation();
  const p = providerOf(provider);
  if (!p) return null;
  return (
    <>
      <a className="ac-link ac-link--muted" href={`https://${p.site}`} target="_blank" rel="noreferrer">
        {t("onboarding.keySite", { site: p.site })}
      </a>
      {p.plans && ` ${t("onboarding.keyNotPlan")}`}
      {p.billing && ` ${t("connectAi.key.billing")}`}
      {p.privacy && ` ${t("connectAi.key.privacy")}`}
    </>
  );
}

/** A key its provider refused on its test call: why, in the provider's words too, and the page that fixes it. */
export function KeyRefused({ refusal }: { refusal: NonNullable<ReturnType<typeof keyRefusal>> }) {
  return (
    <SettingNote icon="alert" live>
      {refusal.text}{" "}
      {refusal.href && (
        <a className="ac-link" href={refusal.href} target="_blank" rel="noreferrer">
          {refusal.site}
        </a>
      )}
    </SettingNote>
  );
}

/**
 * A key that doesn't look like the chosen provider's: why, and when other providers' keys look like it, one
 * button each so the person says whose it is.
 */
export function KeyMismatch({
  provider,
  apiKey,
  onPick,
}: {
  provider: ProviderId;
  apiKey: string;
  onPick(provider: ProviderId): void;
}) {
  const { t } = useTranslation();
  const others = providersForKey(apiKey);
  return (
    <>
      {t(`onboarding.keyInvalid.${provider}`)}
      {others.length > 0 && (
        <span className="row">
          {t("onboarding.keyFromOther")}
          {others.map((p) => (
            <Button key={p.id} size="sm" variant="ghost" onClick={() => onPick(p.id)}>
              <ProviderLogo id={p.id} size="xs" />
              {p.label}
            </Button>
          ))}
        </span>
      )}
    </>
  );
}
