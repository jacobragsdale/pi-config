/** Test-only tool "lookup" with no renderers of its own: it answers "found 3 matches". */
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const lookup = defineTool({
  name: "lookup",
  label: "Lookup",
  description: "Look something up",
  parameters: Type.Object({}),
  execute: () => Promise.resolve({ content: [{ type: "text", text: "found 3 matches" }], details: undefined })
});

export default function lookupTool(pi: ExtensionAPI): void {
  pi.registerTool(lookup);
}
