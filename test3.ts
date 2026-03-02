import { createSession } from "@neovate/code";

async function main() {
    try {
        const session = await createSession({
            model: "noop:noop", // Some fake format maybe bypasses? 
            cwd: process.cwd(),
            providers: {
                "noop": {
                    api: "openai",
                    apiFormat: "openai",
                    options: { apiKey: "fake", baseURL: "http://localhost/" }
                }
            }
        });

        const bus = (session as any).messageBus;

        console.log("Requesting providers.list");
        const providersResponse = await bus.request("providers.list", {});
        console.log("Providers found:", providersResponse?.providers?.length);

        console.log("Requesting models.list");
        const modelsResponse = await bus.request("models.list", {});
        console.log("Models found:", modelsResponse?.models?.length);

        session.close();
    } catch (e: any) {
        console.error("Initialization Failed:", e.message);
    }
}

main();
