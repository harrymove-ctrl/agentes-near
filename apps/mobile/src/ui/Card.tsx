import { Children, cloneElement, isValidElement, type ReactNode } from "react";
import { type StyleProp, View, type ViewStyle } from "react-native";
import { Row, type RowProps } from "./Row";
import { useTheme } from "./theme";

export interface CardProps {
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
}

/**
 * The neutral raised surface (radius 20, elevation e1 and the lit top edge). Rows placed directly inside
 * get a divider between them, inset after the leading avatar.
 */
export function Card({ children, style }: CardProps) {
  const { colors, shadows } = useTheme();
  let index = 0;
  const content = Children.map(children, (child) => {
    if (isValidElement<RowProps>(child) && child.type === Row) {
      const divided = index > 0;
      index++;
      return divided ? cloneElement(child, { divider: child.props.divider ?? true }) : child;
    }
    return child;
  });
  return (
    <View
      style={[{ borderRadius: 20, backgroundColor: colors.raised, boxShadow: `${shadows.e1}, ${shadows.top}` }, style]}
    >
      <View style={{ borderRadius: 20, overflow: "hidden" }}>{content}</View>
    </View>
  );
}
