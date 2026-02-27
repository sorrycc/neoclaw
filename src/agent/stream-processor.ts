import type { SDKSession } from "@neovate/code";
import type { OutboundMessage } from "../bus/types.js";
import { logger } from "../logger.js";

export async function* processStream(
  session: SDKSession,
  reply: (content: string, progress?: boolean) => OutboundMessage,
): AsyncGenerator<OutboundMessage, string> {
  let finalContent = "";

  for await (const m of session.receive()) {
    if (m.type === "system") {
      logger.debug("agent", `init session=${m.sessionId} model=${m.model} tools=${m.tools.join(",")}`);

    } else if (m.type === "message" && "role" in m && m.role === "assistant") {
      if (Array.isArray(m.content)) {
        for (const part of m.content) {
          if (part.type === "text" && part.text) {
            yield reply(part.text, true);
          } else if (part.type === "reasoning" && part.text) {
            logger.debug("agent", `thinking: ${part.text.slice(0, 120)}`);
            yield reply(part.text, true);
          } else if (part.type === "tool_use") {
            logger.debug("agent", `tool_use: ${part.displayName || part.name} id=${part.id} input=${JSON.stringify(part.input).slice(0, 100)}`);
          }
        }
      } else {
        const text = m.text || (typeof m.content === "string" ? m.content : "");
        if (text) yield reply(text, true);
      }

    } else if (m.type === "message" && "role" in m && (m.role === "tool" || m.role === "user")) {
      const parts = Array.isArray(m.content) ? m.content : [];
      for (const part of parts) {
        if ("name" in part) {
          const status = (part as any).result?.isError ? "error" : "ok";
          logger.debug("agent", `tool_result: ${(part as any).name} status=${status}`);
        }
      }

    } else if (m.type === "result") {
      finalContent = m.content;
      const status = m.isError ? "error" : "success";
      logger.debug("agent", `result: ${status} content=${JSON.stringify(finalContent).slice(0, 80)}`);
      if (m.usage) {
        logger.info("agent", `usage: in=${m.usage.input_tokens} out=${m.usage.output_tokens}`);
      }
    }
  }

  return finalContent;
}
