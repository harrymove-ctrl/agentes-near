# 0157. Sharing a file, and the page a refused link shows

- Status: Accepted (built)
- Date: 2026-11-07
- Amends: 0151 §8 (Drive files kept their conversation as their only audience), 0111 (who sees a file)
- Code: engine `artifacts.ts` (`FileSharing`, `personCanRead`, `readsWhereItLives`, `runSharedSql`, `canRead`,
  `listArtifacts`, `setFileSharing`, `withPersonFacts` `canShare`, `fileReach`, the `file` search document),
  `task-access.ts` (`fileSharedSql`, `fileSeenSql`), `search.ts` (`fileSearchScopes`, the file hits' check); adapters
  `search.ts` (`visibleFileScopes`); server `routes/app/artifacts.ts` (`PUT …/artifacts/{id}/sharing`),
  `http/error-page.ts`, `app.ts`; tokens `message-links.ts` (`filePath`, `parseFileLink`); client `lib/drive.ts`
  (`isPrivateArtifact`, `onlyItsConversation`, `toggledSharing`), `useSetArtifactSharing`; web
  `components/artifacts/ShareDialog.tsx`, `ArtifactActions.tsx`, `ArtifactViewer.tsx`, `ArtifactCard.tsx`,
  `drive/DriveDetails.tsx`, `drive/DriveItems.tsx`, `pages/DrivePage.tsx`, `chat/FileRef.tsx`, `lib/markdown.tsx`;
  phone `features/files/ShareSheet.tsx`, `app/(app)/file-share.tsx`, `features/files/actions.ts`,
  `features/chat/FileRefText.tsx`, `features/links/app-links.ts`; migration `0243_file_sharing.sql`

## Context

A member copied a file's address out of her DM with an agent and sent it to the owner. The address was the API's
(`/api/app/organizations/<org>/artifacts/<id>/file?version=2&format=pdf`): Baixar › PDF downloads through an
`<a download>` that points at it, and the browser's downloads keep that address as the file's source. The owner's
browser showed the API's JSON, "Artifact not found": nobody else reads someone's DM, and "not found" is on purpose,
so it never says a private conversation holds a file. Nothing let her show the file to him, and nothing told either of
them why the link didn't open.

## Decision

### 1. A file's sharing, on top of where it lives

A file still lives in its conversation (`artifacts.channel_id`) and everyone who reads it there keeps seeing it. Its
sharing adds to that (`artifacts.share`, `share_user_ids`, `share_role_ids`):

- `conversation`, the default and every file's state before this: nobody more.
- `people`: the people and roles chosen, and administrators, who always see a list as they do a task's or a page's.
- `everyone`: the whole workspace.

It only widens. A file in the shared Drive or a public channel is the workspace's already, and has nothing to share
(`artifact.sharing_open`). Narrowing a file below its conversation was not asked for and would be a second rule in
every path.

**Who changes it**: whoever reads the file where it lives (`readsWhereItLives`): a DM's participants, a channel's
members and administrators, whoever sees a task for its conversation. Someone it was shared with sees it but doesn't
pass it on (`artifact.sharing_forbidden`), as a viewer in Google Drive. A list holds active members and the
workspace's own roles, never the `everyone` role, at most 200 of each; an empty one is refused
(`artifact.sharing_empty`), and the apps send the conversation alone when the last one is taken out.
Each change is an audit row, `artifact.sharing_changed`, with the mode and the ids, never the title.

**Every path for people** goes through it: `personCanRead` (opening, versions, downloads, exports, restoring),
`listArtifacts` (`fileSharedSql`), the trash list, and search. A file shared with everyone is indexed for the whole
workspace; one shared with people keeps its conversation as its document's scope, so its conversation and the agents
there keep finding it, and the people a list names find it by its own id (`visibleFileScopes`, matched on the
document's `sourceId`), which `searchForUser` passes; a file hit is checked against the file, since its document
follows a change a moment later. An adapter that ignores the field keeps it to its conversation, the safe side.
Someone it was shared with sees where it lives without being told it's theirs: a DM's audience names its sides
(`between`, never "you and …") and a channel's says `outside`, and neither offers a way into the conversation.

**Agents** follow the wiki's rule for what sharing adds (ADR 0023 addendum, `runSharedSql`): a run reaches a shared
file only when the person behind it and everyone who reads its conversation see it, since what it says reaches them
all, and with nobody behind it only a file shared with the whole workspace. Who reads the conversation is
`channelReaderSql` (plus everyone for a public channel), not its members: no person is a member of a task's
conversation, which whoever sees the task reads. Their own reach and what they read for a
person where the file lives stay as they were. An agent's search for a person doesn't get the people-shared scopes.
`fileReach` tells an agent who a file was shared with, and `share_artifact` attaches a workspace-shared file as is.

### 2. Compartilhar

One dialog, Google Drive's shape: the file's name; Quem vê with its three options, changed in place (Desfazer on the
web's toast); who has access (the conversation, the people and roles chosen, or the workspace); Copiar link at the
foot. Opened from the viewer's header beside Baixar, the Drive's file menu, an attachment's menu in a message, and
the phone's file screen (a sheet). While only a private conversation sees the file, the dialog says beside Copiar
link that people outside it won't open the link, with Escolher pessoas right there. Every other Copiar link of a file
follows the same rule (`onlyItsConversation`): it copies at once when everyone it may reach opens it, and opens the
dialog otherwise; Copiar links of several files says when some only open inside their conversation, with
Compartilhar.

### 3. Links

Every link the apps give for a file is the app's (`filePath`, `/org/<org>/drive?artifact=<id>&v=<n>`), which opens
the file in the app (the web's viewer; the phone's file screen through its app links). A download still needs the
API's address, so it stays the download's; opened from outside the app it now shows §4's page. A file's link pasted in
a message, the app's or the API's, shows as a pill with the file's name that opens it in the app, and as Arquivo sem
acesso for who can't open it.

### 4. The page a refused link shows

A request a person's browser navigates to (`Sec-Fetch-Mode: navigate` with a document destination, or no fetch
metadata and an `Accept` that prefers HTML) under `/api/` that the API answers with an error gets an HTML page in place
of the JSON (`errorPages`, after every API route), with the same status: the logo, the sign-in pages' sky, the kit's
type and colors (`@agenteschat/tokens`), light and dark, in the person's saved language, else the landing's cookie,
else the browser's. The JSON's code says the cause, and each cause has one way out:

- not signed in (401): sign in, and the sign-in page comes back to the same link;
- a file not found or out of reach (403, 404, 410 on a file's route): one wording for both, as the API keeps them;
  it may have been deleted or be shared only in a conversation the reader isn't in, ask whoever sent it to share it
  from Compartilhar, and open agentes.chat; any other route: the link isn't available, ask for a new one;
- a version or a format the file doesn't have (`artifact.version_not_found`, `artifact.format_unavailable`, read
  only after the file's check; a version that isn't a whole number is one it doesn't have): say so, and open the
  file in the app (its latest version);
- too many tries (429), and a failure of ours (5xx, with the request's id as the error's code): try again;
- anything else: the link didn't open, ask for a new one.

The page runs no script and loads nothing (its own policy). Programs keep the JSON: the apps' fetches, the phone,
agents and scripts never send a navigation, and a download from the app (an empty destination) doesn't either. Two
answers carry a code of their own now, `artifact.version_not_found` (was `not_found`) and `artifact.format_unavailable`
(was `invalid_request`), with the same status and message. Self-host and Cloud alike.

## What stays as it is

- Narrowing a file, viewer and editor levels, and a notice to the people a file is shared with.
- The download's own address, as §3 says.
- Painéis, tasks and wiki pages keep their audiences (ADR 0135, 0151).
