import { createFileRoute } from "@tanstack/react-router";
import { OcelliLandingPage } from "@/pages/OcelliLandingPage";

/** Public welcome alias rendering the Ocelli NEAR landing page (`/welcome`). */
export const Route = createFileRoute("/welcome")({
  component: OcelliLandingPage,
});
