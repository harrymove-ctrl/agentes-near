import { meQuery } from "@agenteschat/client";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { takeFragmentParam } from "@/lib/fragment";
import { OwnerPage } from "@/pages/OwnerPage";

/** The installer's owner link, `/owner#claim=<token>` (ADR 0060 §6). */
export const Route = createFileRoute("/owner")({
  beforeLoad: async ({ context }) => {
    if (await context.queryClient.ensureQueryData(meQuery(context.api))) throw redirect({ to: "/" });
  },
  component: function Owner() {
    // Once per visit: the fragment leaves the address as it is read.
    const [claim] = useState(() => takeFragmentParam("claim"));
    return <OwnerPage claim={claim} />;
  },
});
