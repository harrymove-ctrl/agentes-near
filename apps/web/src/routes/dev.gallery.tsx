import { createFileRoute, notFound } from "@tanstack/react-router";
import { GalleryPage } from "@/pages/GalleryPage";

/** Component gallery, development builds only. */
export const Route = createFileRoute("/dev/gallery")({
  beforeLoad: () => {
    if (!import.meta.env.DEV) throw notFound();
  },
  component: GalleryPage,
});
