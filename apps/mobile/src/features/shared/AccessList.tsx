import { View } from "react-native";
import { GroupedHeader, type IconName, Text } from "@/ui";
import { ActionList } from "./parts";

export interface AccessListRow<L extends string = string> {
  key: string;
  icon: IconName;
  label: string;
  hint?: string;
  level: L;
  /** The levels this row walks through, in order; a tap goes to the next. */
  levels: L[];
  onChange: (level: L) => void;
  /** Words on the right instead of the level's name ("Adicionar"). */
  action?: string;
}

/**
 * Who has access to something, the phone's `AccessDialog`: a row per person, role or agent with its level on the right.
 * It knows nothing of what it guards: the caller gives the rows and their levels.
 */
export function AccessList<L extends string>({
  title,
  rows,
  levelName,
}: {
  title?: string;
  rows: AccessListRow<L>[];
  levelName: (level: L) => string;
}) {
  if (rows.length === 0) return null;
  return (
    // A settings group on the grouped gray: its header as every group's, then the rows.
    <View style={{ paddingHorizontal: 16 }}>
      {title ? <GroupedHeader>{title}</GroupedHeader> : null}
      <ActionList
        items={rows.map((r) => ({
          key: r.key,
          icon: r.icon,
          label: r.label,
          ...(r.hint ? { hint: r.hint } : {}),
          trailing: (
            <Text variant="subhead" tone="faint">
              {r.action ?? levelName(r.level)}
            </Text>
          ),
          onPress: () => r.onChange(r.levels[(r.levels.indexOf(r.level) + 1) % r.levels.length] ?? r.level),
        }))}
      />
    </View>
  );
}
