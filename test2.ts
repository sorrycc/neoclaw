import { createSession } from "@neovate/code";
async function main() {
  const session = await createSession({
    model: "openai:gpt-4o",
    cwd: process.cwd(),
  });
  const res = await (session as any).messageBus.request("providers.list", {});
  console.log("providers.list result:", Object.keys(res), JSON.stringify(res.providers).substring(0, 100));
  
  const mRes = await (session as any).messageBus.request("models.list", {});
  console.log("models.list result:", Object.keys(mRes), mRes.models?.length);
  
  session.close();
}
main();
