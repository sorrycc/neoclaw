import { createSession } from "@neovate/code";
async function main() {
  const session = await createSession({
    model: "noop",
    cwd: process.cwd(),
  });
  console.log("session keys:", Object.keys(session));
  session.close();
}
main();
