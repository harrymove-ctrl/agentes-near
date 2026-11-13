/**
 * Tones for the pixel sky. Every sky is a short list of colors from deep (0)
 * to light (last); the dither picks between neighbours. The agents' world is
 * the sky blue (same in both themes); an agent's own sky uses its color.
 * The functions live in `./math` (DOM-free, shared with the phone app).
 */
export { agentTones, EYE, glowTones, mix, parseColor, pixelOf, SKY_TONES, softTones, spriteTone } from "./math";
