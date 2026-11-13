import type { AgentesModule } from "@agenteschat/modules";
import { createModelProviders, PROVIDERS } from "@agenteschat/providers";
import { allowsPrivateEndpoints, publicHttpsFetch } from "@agenteschat/engine";
import { wrapWithZenDemoProviders } from "./demo-provider";
import { seedZenWorkspace, ZEN_DEMO_PERSONAS } from "./seed";

export const zenModule: AgentesModule = {
  name: "ergo-zen-poc",
  adapters(ctx) {
    const coreProviders = createModelProviders({
      endpointFetch: allowsPrivateEndpoints(ctx.config) ? undefined : publicHttpsFetch(),
      version: ctx.version,
    });
    const wrapped = wrapWithZenDemoProviders(ctx.db, coreProviders);
    // Ensure every catalog provider is wrapped
    for (const id of Object.keys(PROVIDERS)) {
      if (!wrapped[id] && coreProviders[id]) {
        wrapped[id] = coreProviders[id];
      }
    }
    return {
      modelProviders: wrapped,
    };
  },
  registerRoutes(api) {
    api.get("/zen/personas", (c) => {
      if (process.env.ZEN_DEMO_MODE === "false") {
        return c.json({ enabled: false, personas: [] });
      }
      return c.json({
        enabled: true,
        codename: "ZEN",
        workspace: "CommandOSS · Ergo ZEN",
        personas: ZEN_DEMO_PERSONAS,
      });
    });
  },
  async onStart(ctx) {
    if (process.env.ZEN_DEMO_MODE === "false") return;
    await seedZenWorkspace(ctx.db, ctx.adapters.keyWrapper);
  },
};
