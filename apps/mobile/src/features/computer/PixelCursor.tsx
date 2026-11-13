import { memo } from "react";
import Svg, { Rect } from "react-native-svg";
import { CURSOR_CELLS, type CursorCell, cursorCells } from "./pixel-cursor";

/** Fixed, whatever the app's theme: it draws over the agent's desktop, never over the app. */
const COLORS: Record<CursorCell["tone"], string> = { rim: "#ffffff", body: "#3f4bd0", light: "#8f9bff" };

const CELLS = cursorCells();

/** Points per cell: 2 keeps the arrow's pixels crisp, and about as large as a fingertip's aim needs. */
export const CURSOR_SIZE = { width: CURSOR_CELLS.width * 2, height: CURSOR_CELLS.height * 2 };

/** The person's pointer, drawn by the app over the screen (`pixel-cursor.ts`). */
export const PixelCursor = memo(function PixelCursor() {
  return (
    <Svg
      width={CURSOR_SIZE.width}
      height={CURSOR_SIZE.height}
      viewBox={`0 0 ${CURSOR_CELLS.width} ${CURSOR_CELLS.height}`}
    >
      {CELLS.map((c) => (
        <Rect key={`${c.x}-${c.y}`} x={c.x} y={c.y} width={1.02} height={1.02} fill={COLORS[c.tone]} />
      ))}
    </Svg>
  );
});
