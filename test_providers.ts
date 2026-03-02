import { createSession } from "@neovate/code";

async function main() {
    const session = await createSession({
        model: "openai:gpt-4o",
        cwd: __dirname,
        providers: {}
    });
    const bus = session.messageBus as any;
    const listRes = await bus.request("providers.list", { cwd: __dirname });
    console.log(JSON.stringify(listRes.data.providers.find((p: any) => p.id === 'moonshotai-cn'), null, 2));
    process.exit(0);
}
main();
