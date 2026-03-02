import { _ConfigManager } from "@neovate/code";
async function main() {
  const cfg = new _ConfigManager(process.cwd(), "neovate");
  const config = await cfg.getConfig();
  console.log("Config structure:", Object.keys(config));
}
main();
