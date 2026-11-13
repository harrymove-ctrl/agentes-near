/**
 * The person's own area, asked once per account during the onboarding ("And you, what do you look after?"): about
 * the person, never the workspace, so the people who run the server can see which kinds of people stay. One list for
 * the apps and the server, which accepts only these ids or `skipped` (`PUT /me/work-area`).
 */
export const WORK_AREAS = ["dev", "marketing", "sales", "finance", "ops", "support", "other"] as const;
export type WorkArea = (typeof WORK_AREAS)[number];

/** Stored when the person skipped the question: asked once, never again. */
export const WORK_AREA_SKIPPED = "skipped";

/** What `users.work_area` holds once the question was answered or skipped. */
export const WORK_AREA_ANSWERS = [...WORK_AREAS, WORK_AREA_SKIPPED] as const;
export type WorkAreaAnswer = (typeof WORK_AREA_ANSWERS)[number];

export const isWorkAreaAnswer = (v: unknown): v is WorkAreaAnswer =>
  typeof v === "string" && (WORK_AREA_ANSWERS as readonly string[]).includes(v);
