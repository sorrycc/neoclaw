import { join } from "path";
const index = require("@neovate/code/dist/index.mjs");
const handlers = [];
for(const key of Object.keys(index)) {
   if (typeof index[key] === 'function' && index[key].toString().includes('providers.list')) {
       handlers.push(key);
   }
}
console.log("Found handlers:", handlers);
