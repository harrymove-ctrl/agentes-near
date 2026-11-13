/**
 * An @handle that is an id another app gave its agent, not one someone chose: it holds the start of a UUID
 * (`agent-e9665a97-c8d5-423f-ae59-25`, an OpenBot.run id cut to our 32 characters).
 */
export const isIdHandle = (handle: string) => /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i.test(handle);

/** A last word that tells same-named relatives apart ("III", "Jr.", "Filho"), not a surname. */
const AGNOMEN = /^(?:jr|sr|ii|iii|iv|j[uú]nior|filho|neto|sobrinho)\.?$/i;

/** Han, kana or Hangul first: a name with no initials, whose first glyph alone fills a small tile, as on the phone. */
const CJK_START = /^[\u1100-\u11ff\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/;

/**
 * 1–2 letters: "Ada" → "A"; "Marina Souza" → "MS"; "Christopher Alexander Montgomery III" → "CM"; "佐藤 花子" → "佐". A
 * word that starts with no letter ("🌴 Ana Souza") gives way to those that do, and a first character is taken whole: an
 * emoji is two UTF-16 units, and half of one draws as "�".
 */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const lettered = words.filter((w) => /^[\p{L}\p{N}]/u.test(w));
  const named = lettered.length > 0 ? lettered : words;
  const parts = named.length > 2 && AGNOMEN.test(named[named.length - 1] ?? "") ? named.slice(0, -1) : named;
  const first = (w: string | undefined) => Array.from(w ?? "")[0] ?? "";
  if (parts.length === 0) return "?";
  if (parts.length === 1 || CJK_START.test(parts[0] ?? "")) return first(parts[0]).toUpperCase() || "?";
  return `${first(parts[0])}${first(parts[parts.length - 1])}`.toUpperCase();
}

/**
 * Where apps keep keys and sign-ins, whatever the format: env files, auth and token files, keys, the config files of
 * tools that keep a token, credential folders and browser profiles. An import never reads these, only lists them.
 */
const WORDS = "(?:token|oauth|secret|credential|password|cookie)";
const SECRET_PATH = new RegExp(
  [
    "(?:^|/)\\.env(?:[./][^/]*)?$",
    "(?:^|/)[^/]+\\.env$",
    "(?:^|/)\\.envrc$",
    "(?:^|/)auth[^/]*\\.json$",
    // Credential words only in the names such stores have: a data file (`cookies.txt`, `client_secret.json`) or no
    // type at all, never a document (`password-policy.pdf`, `secret-santa.xlsx`, `tokens.md`).
    `(?:^|/)[^/]*${WORDS}[^/]*\\.(?:json|txt|ya?ml|ini|cfg|conf|toml|csv|xml|plist|db|sqlite3?|dat)$`,
    `(?:^|/)[^/.]*${WORDS}[^/.]*$`,
    "(?:^|/)[^/]*private[^/]*key[^/]*$",
    // Not `.key`: a Keynote deck too; a private key in one is found by what it holds.
    "\\.(?:pem|p8|p12|pfx|ppk|jks|keystore|kdbx|gpg|asc|ovpn|tfvars(?:\\.json)?)$",
    "(?:^|/)id_(?:rsa|dsa|ecdsa|ed25519)[^/]*$",
    "(?:^|/)\\.?npmrc$",
    "(?:^|/)(?:[._]netrc|\\.pgpass|\\.htpasswd|\\.pypirc|\\.s3cfg|\\.boto|kubeconfig(?:\\.ya?ml)?)$",
    "(?:^|/)(?:honcho|mem0|cursor-session|mcp-oauth|teams_pipeline_store)\\.json$",
    "(?:^|/)(?:credentials|mcp-tokens|vault|secrets|proxy|\\.ssh|\\.aws|\\.gnupg|\\.kube|\\.docker|\\.azure)/",
    "(?:^|/)\\.config/(?:gh|gcloud)/",
    "(?:^|/)(?:chrome-debug|bot-desktop|browser-profiles?|chromium|playwright|[^/]*-profile)/",
    "(?:^|/)(?:Cookies|Login Data|Local State|Web Data)$",
  ].join("|"),
  "i",
);
export const isSecretPath = (path: string) => SECRET_PATH.test(path.replace(/\\/g, "/"));

/** A note that is a list of logins by its name (`passwords.md`, `credentials.md`): read by an import, never copied. */
const SECRET_NOTE = /(?:^|\/)(?:my[-_ ]?)?(?:passwords?|credentials?|secrets?|logins?|senhas?)\.(?:md|markdown|txt)$/i;
/** Never copied into the Drive, by its name: a credential store, or a note named like one. */
export const isSecretFile = (path: string) => isSecretPath(path) || SECRET_NOTE.test(path.replace(/\\/g, "/"));

/**
 * A credential set in a file's text: `name: value`, `NAME=value`, JSON's `"name": "value"`, `_` before the name too
 * (`DB_PASSWORD`). Stricter on the value than memory's check, since a script or a doc names these all the time: a
 * placeholder (`YOUR_API_KEY`, `your-key-here`, `xxx`, `<token>`) or code (`get_token()`, `${TOKEN}`, `os.environ[…]`)
 * isn't one.
 */
const CREDENTIAL_SET =
  /(?:\b|_)(?:password|senha|passwd|secret(?:[_-]?(?:access[_-]?)?key)?|api[_ -]?key|token)["']?\s*[:=]\s*["']?([^\s"',;]{6,})/gi;
const NOT_A_VALUE = /your|xxx|changeme|example|placeholder|[<>${}()[\]]|^(?:os|process|env|self|this|config)\./i;
export const setsCredential = (text: string) =>
  [...text.matchAll(CREDENTIAL_SET)].some(([, value = ""]) => !/^[A-Z0-9_]+$/.test(value) && !NOT_A_VALUE.test(value));

/** The Drive folder an imported agent's files go in: its name, with no `/` to read as a deeper folder. */
export const driveFolder = (agentName: string) => agentName.replace(/[\\/]+/g, "-").trim() || "agent";
