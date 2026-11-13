import { colorKey, gradientOf, isHexColor } from "@agenteschat/ui/agent/engine";
import { LinearGradient } from "expo-linear-gradient";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { AgentAvatar, Button, GroupedHeader, GroupedList, GroupedRow, Icon, Sheet, Text } from "@/ui";
import { useColors } from "../shared/hooks";
import { AGENT_ACCESSORIES, AGENT_COLORS, AGENT_EYES } from "../shared/logic";
import { SheetTitle } from "../shared/PromptForm";
import { tapHaptic } from "../shared/parts";
import { ColorSheet } from "./ColorSheet";
import { type FullLook, shuffleLook } from "./edit";

/**
 * An agent's look, as the web's picker: color swatches, then eyes and accessories drawn on the agent
 * itself, each in a row that scrolls sideways, and "Sortear". Used by "Edit"; "Create agent" lists the
 * same choices on its grouped gray (`LookList`).
 */
export function LookPicker({ look, onChange }: { look: FullLook; onChange: (next: FullLook) => void }) {
  const { t } = useTranslation();
  const color = useColorSheet(look, onChange);
  const set = (patch: Partial<FullLook>) => {
    tapHaptic();
    onChange({ ...look, ...patch });
  };
  return (
    <View style={styles.wrap}>
      <View style={styles.head}>
        <Label text={t("look.color")} value={t(`look.colors.${colorKey(look.color)}`)} />
        {/* `Button` gives the press's haptic. */}
        <Button
          variant="secondary"
          size="sm"
          icon="sparkle"
          label={t("newAgent.shuffle")}
          onPress={() => onChange(shuffleLook(look))}
        />
      </View>
      <Swatches look={look} onPick={(next) => set({ color: next })} onCustom={color.open} ring />
      {color.sheet}

      <Label text={t("look.eyes")} value={t(`look.eyesNames.${look.eyes}`)} />
      <Choices label={t("look.eyes")}>
        {AGENT_EYES.map((eyes) => (
          <Choice key={eyes} on={look.eyes === eyes} label={t(`look.eyesNames.${eyes}`)} onPress={() => set({ eyes })}>
            <AgentAvatar agent={{ ...look, eyes, accessory: "none" }} size={52} framed={false} live={false} />
          </Choice>
        ))}
      </Choices>

      <Label text={t("look.accessory")} value={t(`look.accessories.${look.accessory}`)} />
      <Choices label={t("look.accessory")}>
        {AGENT_ACCESSORIES.map((accessory) => (
          <Choice
            key={accessory}
            on={look.accessory === accessory}
            label={t(`look.accessories.${accessory}`)}
            onPress={() => set({ accessory })}
          >
            <AgentAvatar agent={{ ...look, accessory }} size={52} framed={false} live={false} />
          </Choice>
        ))}
      </Choices>
    </View>
  );
}

/**
 * The same choices on a grouped list, for "Create agent" on the grouped gray: the colors in one row, the chosen one
 * checked inside (no ring), then "Eyes" and "Accessory" showing what it wears, each opening its choices in a sheet as
 * rows with the check (the sideways rows' gray plates and rings would sit inside the list), and "Shuffle".
 */
export function LookList({ look, onChange }: { look: FullLook; onChange: (next: FullLook) => void }) {
  const { t } = useTranslation();
  const color = useColorSheet(look, onChange);
  const [part, setPart] = useState<"eyes" | "accessory" | null>(null);
  const set = (patch: Partial<FullLook>) => {
    tapHaptic();
    onChange({ ...look, ...patch });
  };
  // The eyes are shown without an accessory, as on the sideways rows, so the face is what changes.
  const bare: FullLook = { ...look, accessory: "none" };
  return (
    <>
      <GroupedHeader>{t("look.color")}</GroupedHeader>
      <GroupedList>
        <Swatches look={look} onPick={(next) => set({ color: next })} onCustom={color.open} />
        <GroupedRow
          label={t("look.eyes")}
          value={t(`look.eyesNames.${look.eyes}`)}
          chevron
          onPress={() => setPart("eyes")}
        />
        <GroupedRow
          label={t("look.accessory")}
          value={t(`look.accessories.${look.accessory}`)}
          chevron
          onPress={() => setPart("accessory")}
        />
        <GroupedRow
          icon="sparkle"
          label={t("newAgent.shuffle")}
          onPress={() => {
            tapHaptic();
            onChange(shuffleLook(look));
          }}
        />
      </GroupedList>
      {color.sheet}
      <PartSheet
        open={part === "eyes"}
        onClose={() => setPart(null)}
        title={t("look.eyes")}
        options={AGENT_EYES.map((eyes) => ({ key: eyes, label: t(`look.eyesNames.${eyes}`), look: { ...bare, eyes } }))}
        value={look.eyes}
        onPick={(eyes) => set({ eyes })}
      />
      <PartSheet
        open={part === "accessory"}
        onClose={() => setPart(null)}
        title={t("look.accessory")}
        options={AGENT_ACCESSORIES.map((accessory) => ({
          key: accessory,
          label: t(`look.accessories.${accessory}`),
          look: { ...look, accessory },
        }))}
        value={look.accessory}
        onPick={(accessory) => set({ accessory })}
      />
    </>
  );
}

/**
 * The custom color's sheet: a new one per opening starts from the color shown then; the same key lets it animate away.
 */
function useColorSheet(look: FullLook, onChange: (next: FullLook) => void) {
  const [picking, setPicking] = useState(false);
  const [opens, setOpens] = useState(0);
  const open = () => {
    tapHaptic();
    setOpens((n) => n + 1);
    setPicking(true);
  };
  const sheet = (
    <ColorSheet
      key={opens}
      open={picking}
      value={look.color}
      onChange={(color) => onChange({ ...look, color })}
      onClose={() => setPicking(false)}
    />
  );
  return { open, sheet };
}

/**
 * The presets and the custom color (a rainbow until one is picked), the chosen one checked inside. `ring` also rings
 * it (Edit's picker); inside a grouped list the check is the only mark, and the row spreads them across.
 */
function Swatches({
  look,
  onPick,
  onCustom,
  ring = false,
}: {
  look: FullLook;
  onPick: (color: (typeof AGENT_COLORS)[number]) => void;
  onCustom: () => void;
  ring?: boolean;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const custom = isHexColor(look.color);
  const frame = (on: boolean) => (ring ? [styles.swatchRing, { borderColor: on ? c.ink : "transparent" }] : null);
  const swatch = ring ? styles.swatch : styles.swatchFlat;
  // A flat swatch is 30 pt: 7 more around it reach the 44 pt a finger needs.
  const slop = ring ? 4 : 7;
  return (
    <View
      style={ring ? styles.swatches : styles.swatchRow}
      accessibilityRole="radiogroup"
      accessibilityLabel={t("look.color")}
    >
      {AGENT_COLORS.map((color) => {
        const [top, bottom] = gradientOf(color);
        const on = look.color === color;
        return (
          <Pressable
            key={color}
            onPress={() => onPick(color)}
            accessibilityRole="radio"
            accessibilityLabel={t(`look.colors.${color}`)}
            accessibilityState={{ selected: on }}
            hitSlop={slop}
            style={({ pressed }) => [frame(on), pressed && styles.pressed]}
          >
            <LinearGradient colors={[top, bottom]} style={swatch}>
              {on ? <Icon name="check" size={16} color="#fff" /> : null}
            </LinearGradient>
          </Pressable>
        );
      })}
      <Pressable
        onPress={onCustom}
        accessibilityRole="radio"
        accessibilityLabel={t("look.customColor")}
        accessibilityState={{ selected: custom }}
        hitSlop={slop}
        style={({ pressed }) => [frame(custom), pressed && styles.pressed]}
      >
        <LinearGradient
          colors={custom ? gradientOf(look.color) : RAINBOW}
          start={custom ? undefined : { x: 0, y: 0 }}
          end={custom ? undefined : { x: 1, y: 1 }}
          style={swatch}
        >
          {custom ? <Icon name="check" size={16} color="#fff" /> : null}
        </LinearGradient>
      </Pressable>
    </View>
  );
}

/** One part's choices in a sheet, each drawn on the agent as it looks now, the one it wears checked: a tap wears it. */
function PartSheet<K extends string>({
  open,
  onClose,
  title,
  options,
  value,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  options: readonly { key: K; label: string; look: FullLook }[];
  value: K;
  onPick: (key: K) => void;
}) {
  return (
    <Sheet open={open} onClose={onClose}>
      <SheetTitle title={title} />
      <GroupedList>
        {options.map((o) => (
          <GroupedRow
            key={o.key}
            leading={<AgentAvatar agent={o.look} size={36} live={false} />}
            label={o.label}
            checked={o.key === value}
            onPress={() => {
              onPick(o.key);
              onClose();
            }}
          />
        ))}
      </GroupedList>
    </Sheet>
  );
}

function Label({ text, value }: { text: string; value: string }) {
  return (
    <Text variant="footnote" tone="faint" style={styles.label}>
      {text}
      <Text variant="footnote" tone="muted">
        {`  ${value}`}
      </Text>
    </Text>
  );
}

function Choices({ label, children }: { label: string; children: ReactNode }) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.choices}
      style={styles.bleed}
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
    >
      {children}
    </ScrollView>
  );
}

function Choice({
  on,
  label,
  onPress,
  children,
}: {
  on: boolean;
  label: string;
  onPress: () => void;
  children: ReactNode;
}) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ selected: on }}
      style={({ pressed }) => [
        styles.choice,
        { backgroundColor: c.sunken, borderColor: on ? c.ink : "transparent" },
        pressed && styles.pressed,
      ]}
    >
      {children}
    </Pressable>
  );
}

/** The ninth swatch before a custom color is picked: the presets' tops, as a rainbow. */
const RAINBOW = ["#f58aa6", "#f3c25c", "#5fcf8b", "#8cc3ff", "#ae8cf7"] as const;

const styles = StyleSheet.create({
  wrap: { gap: 10 },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  label: { marginTop: 4 },
  swatches: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  swatchRing: { borderWidth: 2, borderRadius: 999, padding: 2 },
  swatch: { width: 34, height: 34, borderRadius: 999, alignItems: "center", justifyContent: "center" },
  // Nine across a phone's list: spread over the row, onto a second line only on the narrowest screens.
  swatchRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    rowGap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  swatchFlat: { width: 30, height: 30, borderRadius: 999, alignItems: "center", justifyContent: "center" },
  bleed: { marginHorizontal: -18 },
  choices: { gap: 8, paddingHorizontal: 18 },
  choice: { width: 68, height: 68, borderRadius: 20, borderWidth: 2, alignItems: "center", justifyContent: "center" },
  pressed: { transform: [{ scale: 0.96 }] },
});
