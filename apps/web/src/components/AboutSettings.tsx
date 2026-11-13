import { instanceQuery } from "@agenteschat/client";
import { LICENSE_URL, PUBLIC_SOURCE_URL } from "@agenteschat/client/lib/about";
import { shownAddress } from "@agenteschat/client/lib/sites";
import { DOCS_SITE } from "@agenteschat/i18n/docs";
import { Card, CardHeader, Icon } from "@agenteschat/ui";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { LoadingLine } from "@/components/Loading";
import { PrefRow } from "@/components/NoticePrefs";

/** An outside page in a new tab, in the house link style. */
function Out({ href, children }: { href: string; children?: ReactNode }) {
  return (
    <a className="ac-link" href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

/**
 * Configurações › Sobre: AGPL-3.0's Appropriate Legal Notices and the attribution the 7(b) term in NOTICE
 * requires. Shown to everyone on every self-hosted server, with no setting that hides it (`showsAbout`).
 */
export function AboutSection() {
  const { t } = useTranslation();
  const instance = useQuery(instanceQuery(useApi()));
  const source = instance.data?.sourceUrl ?? PUBLIC_SOURCE_URL;
  return (
    <Card aria-labelledby="about-made">
      <CardHeader
        id="about-made"
        icon="info"
        title={
          // One inline run: the heading lays its children out with a gap, which would part the link from its words.
          <span>
            <Trans i18nKey="settings.about.basedOn" components={{ site: <Out href={DOCS_SITE} /> }} />
          </span>
        }
        subtitle={<Trans i18nKey="settings.about.license" components={{ license: <Out href={LICENSE_URL} /> }} />}
      />
      <div className="settings-rows">
        <PrefRow
          id="about-version"
          icon="download"
          label={t("settings.about.version")}
          control={instance.data ? <span className="ac-num">{instance.data.version}</span> : <LoadingLine width={80} />}
        />
        <PrefRow
          id="about-source"
          icon="code"
          label={t("settings.about.source")}
          control={
            <Out href={source}>
              <span className="ac-iconline">
                {shownAddress(source)}
                <Icon name="external" size={14} />
              </span>
            </Out>
          }
        />
      </div>
      <p className="ac-card__foot">{t("settings.about.copyright")}</p>
    </Card>
  );
}
