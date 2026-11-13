import { type ApiClient, type ArtifactDetail, keys, useApi } from "@agenteschat/client";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Directory, File, Paths } from "expo-file-system";
import * as MediaLibrary from "expo-media-library";
import * as Sharing from "expo-sharing";
import { Platform } from "react-native";
import { appHeaders, readCookie } from "@/lib/auth";
import { serverUrl } from "@/lib/server";
import { router } from "@/ui/navigation";
import { resolveDownloadUrl, type ShareSource, safeFileName, shareSource } from "./logic";

/**
 * Getting at a file's bytes: the short-lived download link (with the session when the link is ours),
 * a copy in the cache for the share sheet, Salvar em Fotos, and the Drive on the web.
 */

/** The server's links live 5 minutes; refetch a bit before. */
const LINK_STALE_MS = 4 * 60 * 1000;

export interface RemoteFile {
  uri: string;
  headers: Record<string, string>;
}

async function remote(api: ApiClient, orgId: string, id: string, version?: number): Promise<RemoteFile> {
  const { url } = await api.artifacts.download(orgId, id, version);
  const r = resolveDownloadUrl(serverUrl(), url);
  return { uri: r.uri, headers: r.needsSession ? appHeaders(await readCookie()) : {} };
}

/** The link to show a picture or a PDF (refreshed before it expires). */
export function useRemoteFile(orgId: string, id: string | null, version?: number) {
  const api = useApi();
  return useQuery({
    queryKey: ["org", orgId, "artifacts", "link", id ?? "", version ?? "latest"] as const,
    queryFn: () => remote(api, orgId, id ?? "", version),
    enabled: Boolean(id),
    staleTime: LINK_STALE_MS,
    gcTime: LINK_STALE_MS,
  });
}

/** Several artifacts at once (a message's files), sharing the cache of `useArtifact`. */
export function useArtifacts(orgId: string, refs: { id: string; version?: number }[]) {
  const api = useApi();
  return useQueries({
    queries: refs.map((r) => ({
      queryKey: keys.artifact(orgId, r.id, r.version),
      queryFn: () => api.artifacts.get(orgId, r.id, r.version),
      staleTime: r.version ? Number.POSITIVE_INFINITY : 0,
    })),
  });
}

/** The text of a Markdown or text file: what the server kept (small files) or the download. */
export async function fileText(api: ApiClient, orgId: string, a: ArtifactDetail): Promise<string> {
  if (a.content.kind === "document") return a.content.markdown;
  if (a.content.kind === "file" && a.content.text !== undefined) return a.content.text;
  const r = await remote(api, orgId, a.id, a.shownVersion);
  const res = await fetch(r.uri, { headers: r.headers, credentials: "omit" });
  if (!res.ok) throw new Error(`download ${res.status}`);
  return res.text();
}

/** A fresh folder per file under the cache, so the copy keeps its real name. */
function cacheFile(a: ArtifactDetail, name: string): File {
  const dir = new Directory(Paths.cache, "files", `${a.id}-${a.shownVersion}`);
  dir.create({ intermediates: true, idempotent: true });
  const file = new File(dir, name);
  if (file.exists) file.delete();
  return file;
}

/** A local copy of the file, with its name and extension (what the share sheet and Fotos get). */
export async function localCopy(
  api: ApiClient,
  orgId: string,
  a: ArtifactDetail,
): Promise<{ uri: string; source: ShareSource }> {
  const source = shareSource(a);
  const file = cacheFile(a, safeFileName(source.name));
  if (source.from === "text") {
    file.write(source.text);
    return { uri: file.uri, source };
  }
  const r =
    source.from === "export"
      ? {
          uri: api.artifacts.fileUrl(orgId, a.id, { version: a.shownVersion, format: source.format }),
          headers: appHeaders(await readCookie()),
        }
      : await remote(api, orgId, a.id, a.shownVersion);
  const done = await File.downloadFileAsync(r.uri, file, { headers: r.headers, idempotent: true });
  return { uri: done.uri, source };
}

/** The system share sheet with the real file (Salvar imagem, Salvar em Arquivos, other apps). */
export async function shareFile(api: ApiClient, orgId: string, a: ArtifactDetail): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) throw new Error("sharing unavailable");
  const { uri, source } = await localCopy(api, orgId, a);
  // On iOS the name already carries the extension; a MIME type there would add a second one.
  await Sharing.shareAsync(
    uri,
    Platform.OS === "android" && source.mime ? { mimeType: source.mime, dialogTitle: source.name } : {},
  );
}

/** Salvar em Fotos: add-only access (never reads the library). False when the person said no. */
export async function saveToPhotos(api: ApiClient, orgId: string, a: ArtifactDetail): Promise<boolean> {
  const perm = await MediaLibrary.requestPermissionsAsync(true, ["photo"]);
  if (!perm.granted) return false;
  const { uri } = await localCopy(api, orgId, a);
  await MediaLibrary.Asset.create(uri);
  return true;
}

/**
 * Ver no Drive: closes the viewer and opens the app's Drive with the file outlined (back on the Drive when the
 * viewer was opened from it).
 */
export function openInDrive(_orgId: string, a: Pick<ArtifactDetail, "id" | "shownVersion" | "version">) {
  if (router.canGoBack()) router.back();
  return new Promise<void>((resolve) =>
    setTimeout(() => {
      router.navigate({ pathname: "/drive", params: { artifact: a.id } });
      resolve();
    }, 60),
  );
}
