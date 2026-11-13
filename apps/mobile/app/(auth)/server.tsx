import { ServerAddress } from "@/features/server/ServerAddress";
import { router } from "@/ui/navigation";

/** "Onde fica o seu agentes.chat?", from the sign-in's line: back to the sign-in when done. */
export default function Server() {
  return <ServerAddress onDone={() => router.back()} />;
}
