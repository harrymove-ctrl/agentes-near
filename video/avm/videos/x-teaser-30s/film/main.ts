/**
 * This video plays its storyboard.json through the slot engine: every slot is a scene template from
 * libs/film-kit/scenes, or a custom scene from custom.ts (template "custom", keyed by slot id).
 */
import { start } from "../../../../../libs/film-kit/film/engine.ts";
import { CUSTOM } from "./custom.ts";

start(CUSTOM);
