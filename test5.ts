import { createSession } from "@neovate/code";
import { join } from "path";

async function main() {
  try {
    console.log("Creating session...");
    const session = await createSession({
      model: "openai:gpt-4o",
      cwd: process.cwd(),
      providers: {}
    });
    console.log("Session created. Requesting providers...");

    const bus = (session as any).messageBus;
    const providersResponse = await bus.request("providers.list", { cwd: process.cwd() });
    console.log("Providers found:", providersResponse?.data?.providers?.length);
    if (providersResponse?.data?.providers) {
      console.log("Sample providers:", providersResponse.data.providers.slice(0, 3).map((p: any) => p.id));
    }

    console.log("Requesting models...");
    const modelsResponse = await bus.request("models.list", { cwd: process.cwd() });
    console.log("Models found:", modelsResponse?.data?.groupedModels?.length);

    session.close();
    console.log("Done.");
  } catch (e: any) {
    console.log("Initialization Failed:", e.message);
  }
}
main();
