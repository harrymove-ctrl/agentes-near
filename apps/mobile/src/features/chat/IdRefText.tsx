import { useIdRef } from "@agenteschat/client";
import type { ReactElement } from "react";
import { Text as RNText, StyleSheet } from "react-native";
import { useOrg } from "@/providers/org";
import { Icon } from "@/ui";
import { router } from "@/ui/navigation";
import { useColors } from "../shared/hooks";
import { FilePillText } from "./FileRefText";
import { MessageRefText } from "./MessageRefText";

/**
 * An internal id written in a text (the web's `IdRef`), as the pill of what it names for this reader: a file (its
 * `FilePillText`, as a file's link shows it), a task ("#13 title", opens it), a message (its link's pill). While it
 * loads, a quiet pill, so the id never shows on its way to its name; one that names nothing the reader sees stays as
 * written (`shown`, a code span's when it was one).
 */
export function IdRefText({ id, shown }: { id: string; shown: ReactElement }) {
  const c = useColors();
  const { orgId } = useOrg();
  const query = useIdRef(orgId, id);
  const ref = query.data;
  if (query.isPending) {
    return (
      <RNText style={[styles.ref, { backgroundColor: c.sunken }]}>
        <Icon name="more" size={14} color={c.muted} />
      </RNText>
    );
  }
  if (!ref) return shown;
  if (ref.kind === "message") {
    const m = ref.message;
    return (
      <MessageRefText
        link={{ orgId, messageId: m.id, channelId: m.threadId ? null : m.channelId, threadId: m.threadId }}
      />
    );
  }
  if (ref.kind === "file") return <FilePillText orgId={orgId} id={ref.id} title={ref.title} />;
  return (
    <RNText
      accessibilityRole="link"
      onPress={() => router.push(`/issues/${ref.number}`)}
      style={[styles.ref, { backgroundColor: c.sunken, color: c.ink }]}
    >
      <Icon name="issue" size={14} color={c.ink} /> {`#${ref.number} ${ref.title}`}
    </RNText>
  );
}

const styles = StyleSheet.create({
  ref: { fontWeight: "600", borderRadius: 4 },
});
