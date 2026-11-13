export { PASTE_MAX_BYTES, pasteBytes } from "@agenteschat/client";
/** Shift+Insert pastes and Ctrl+Insert copies in every window there, a terminal too. Inline: noVNC exports only RFB. */
export const SHIFT = { keysym: 0xffe1, code: "ShiftLeft" };
export const CONTROL = { keysym: 0xffe3, code: "ControlLeft" };
export const INSERT = { keysym: 0xff63, code: "Insert" };
