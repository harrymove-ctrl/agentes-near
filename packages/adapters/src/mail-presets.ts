import type { MailPreset } from "./mail";

/**
 * Known IMAP/SMTP providers (ADR 0038): the person picks one and pastes an
 * app password. Gmail and Outlook are not here: they go through Composio.
 * Every host and port was checked against the provider's own help page
 * (2026-10). SMTP port 465 = implicit TLS; 587 = STARTTLS (required).
 *
 * Left out because no official page confirmed the hosts: KingHost, UOL Host,
 * Zoho's regional data centers (EU, IN, AU…; those people pick `custom`).
 */
export const MAIL_PRESETS: MailPreset[] = [
  {
    // support.apple.com/102525. Custom iCloud+ domains log in with the Apple ID address.
    id: "icloud",
    label: "iCloud",
    imapHost: "imap.mail.me.com",
    imapPort: 993,
    smtpHost: "smtp.mail.me.com",
    smtpPort: 587,
    username: "address",
    // support.apple.com/102654: Sign-In and Security → App-Specific Passwords.
    appPasswordUrl: "https://account.apple.com/account/manage",
  },
  {
    // help.yahoo.com/kb/SLN4075.html
    id: "yahoo",
    label: "Yahoo",
    imapHost: "imap.mail.yahoo.com",
    imapPort: 993,
    smtpHost: "smtp.mail.yahoo.com",
    smtpPort: 465,
    username: "address",
    appPasswordUrl: "https://login.yahoo.com/account/security",
  },
  {
    // zoho.com/mail/help/imap-access.html, zoho-smtp.html (personal and free organization accounts).
    id: "zoho",
    label: "Zoho Mail",
    imapHost: "imap.zoho.com",
    imapPort: 993,
    smtpHost: "smtp.zoho.com",
    smtpPort: 465,
    username: "address",
    appPasswordUrl: "https://accounts.zoho.com/home#security/app_password",
  },
  {
    // Same pages: paid organization accounts on a custom domain.
    id: "zoho-pro",
    label: "Zoho Mail (custom domain)",
    imapHost: "imappro.zoho.com",
    imapPort: 993,
    smtpHost: "smtppro.zoho.com",
    smtpPort: 465,
    username: "address",
    appPasswordUrl: "https://accounts.zoho.com/home#security/app_password",
  },
  {
    // fastmail.help/hc/en-us/articles/1500000278342
    id: "fastmail",
    label: "Fastmail",
    imapHost: "imap.fastmail.com",
    imapPort: 993,
    smtpHost: "smtp.fastmail.com",
    smtpPort: 465,
    username: "address",
    appPasswordUrl: "https://app.fastmail.com/settings/security",
  },
  {
    // locaweb.com.br/ajuda (Android / Outlook setup articles).
    id: "locaweb",
    label: "Locaweb",
    imapHost: "email-ssl.com.br",
    imapPort: 993,
    smtpHost: "email-ssl.com.br",
    smtpPort: 465,
    username: "address",
    appPasswordUrl: null,
  },
  {
    // support.hostinger.com/en/articles/1575756
    id: "hostinger",
    label: "Hostinger",
    imapHost: "imap.hostinger.com",
    imapPort: 993,
    smtpHost: "smtp.hostinger.com",
    smtpPort: 465,
    username: "address",
    appPasswordUrl: null,
  },
  {
    // godaddy.com/help/32204 (Professional Email).
    id: "godaddy",
    label: "GoDaddy",
    imapHost: "imap.secureserver.net",
    imapPort: 993,
    smtpHost: "smtpout.secureserver.net",
    smtpPort: 465,
    username: "address",
    appPasswordUrl: null,
  },
  {
    // support.titan.email/hc/en-us/articles/900000573066 (EU-hosted accounts use other hosts: custom).
    id: "titan",
    label: "Titan",
    imapHost: "imap.titan.email",
    imapPort: 993,
    smtpHost: "smtp.titan.email",
    smtpPort: 465,
    username: "address",
    appPasswordUrl: null,
  },
  {
    // ionos.com/help/email/general-topics/ionos-mail-server-details-for-imap-pop3-and-smtp/
    id: "ionos",
    label: "IONOS",
    imapHost: "imap.ionos.com",
    imapPort: 993,
    smtpHost: "smtp.ionos.com",
    smtpPort: 465,
    username: "address",
    appPasswordUrl: null,
  },
  {
    // The person types the hosts.
    id: "custom",
    label: "Other (IMAP/SMTP)",
    imapHost: "",
    imapPort: 993,
    smtpHost: "",
    smtpPort: 587,
    username: "address",
    appPasswordUrl: null,
  },
];
