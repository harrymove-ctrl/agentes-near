import { useIdRef } from "@agenteschat/client";
import { Icon } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { FilePill } from "@/chat/FileRef";
import { MessageRef } from "@/chat/MessageRef";
import { useInPlace } from "@/components/InPlace";
import { useOrg } from "@/components/org-context";
import type { IdRenderer } from "@/lib/markdown";
import { inPlaceClick } from "@/lib/navigate";

/**
 * An internal id written in a text (`splitIdRefs`), as the pill of what it names for this reader: a file (its
 * `FilePill`, as a file's link shows it), a task ("#13 title", opening it), a message (its link's pill). While it loads,
 * a quiet pill, so the id never shows on its way to its name; one that names nothing the reader sees stays as written
 * (`shown`: as its code span, when it was one).
 */
export function IdRef({ id, text, shown }: { id: string; text: string; shown?: ReactNode }) {
  const { org } = useOrg();
  const inPlace = useInPlace();
  const query = useIdRef(org.id, id);
  const ref = query.data;
  if (query.isPending) {
    return (
      <span className="channel-ref id-ref" aria-busy="true">
        <Icon name="more" />
      </span>
    );
  }
  if (!ref) return shown ?? <>{text}</>;
  if (ref.kind === "message") {
    const m = ref.message;
    return (
      <MessageRef
        link={{
          orgId: org.id,
          messageId: m.id,
          channelId: m.threadId ? null : m.channelId,
          threadId: m.threadId,
        }}
      />
    );
  }
  if (ref.kind === "task") {
    const number = ref.number;
    return (
      <Link
        to="/org/$orgId/issues/$number"
        params={{ orgId: org.id, number: String(number) }}
        className="channel-ref id-ref"
        onClick={inPlace ? (e) => inPlaceClick(e, () => inPlace.issue(number)) : undefined}
      >
        <Icon name="issues" />#{number} {ref.title}
      </Link>
    );
  }
  return (
    <FilePill
      orgId={org.id}
      file={{
        id: ref.id,
        title: ref.title,
        kind: ref.artifactKind,
        fileName: ref.fileName,
        contentType: ref.contentType,
      }}
    />
  );
}

/** The renderer to pass to `<Markdown idRef>` where people read what agents write: chat, tasks, the wiki. */
export const renderIdRef: IdRenderer = (id, text, key, shown): ReactNode => (
  <IdRef key={key} id={id} text={text} shown={shown} />
);
