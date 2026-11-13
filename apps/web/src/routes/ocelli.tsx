import { createFileRoute } from "@tanstack/react-router";
import { OcelliLandingPage } from "@/pages/OcelliLandingPage";

/** Public Ocelli NEAR + Bayer dithered showcase landing page (`/ocelli`). */
export const Route = createFileRoute("/ocelli")({
  component: OcelliLandingPage,
});
