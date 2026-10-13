import { z } from "zod";

/**
 * Minimal guided workflow for building a data-bound page from a design + API spec.
 *
 * Deliberately short and project-agnostic: the full workflow (project
 * conventions, mock/live verification, visual diffing) lives in the
 * `figma-to-page` skill in this repo's `skills/` directory, which projects
 * copy and adapt. Keeping the detailed steps in one place avoids the prompt,
 * the tool description and the skill drifting apart. This prompt is the
 * fallback for clients or projects without that skill.
 */
export const implementDesignWithApiPrompt = {
  name: "implement_design_with_api",
  title: "Implement design with backend API",
  description:
    "Implement a Figma design as a working page wired to the backend API described by an OpenAPI/Swagger spec.",
  argsSchema: {
    figmaUrl: z.string().describe("Link to the Figma frame or component to implement"),
    spec: z
      .string()
      .optional()
      .describe(
        "OpenAPI/Swagger spec: absolute file path (e.g. an exported swagger.json) or spec URL. Leave empty to use the configured one, or to be asked.",
      ),
  },
  build: ({ figmaUrl, spec }: { figmaUrl: string; spec?: string }) => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Implement the Figma design at ${figmaUrl} as a working page connected to our backend API. If the project has a figma-to-page skill, follow it instead of the steps below.

${
  spec?.trim()
    ? `The API spec is ${spec.trim()}; pass it as \`spec\` on every get_api_context call.`
    : "Before step 3, settle which API spec to use: the server's configured one, a location recorded in the project's conventions, or a spec file in the project. If none applies, ask me where it is; don't guess."
}

1. Call get_figma_data. Build the static UI first with the design's placeholder content, following the project's existing components and conventions.
2. Collect keywords from the design: visible text, semantic layer names, and repeated structures (nodes with \`template=\` pointing into the ELEMENTS section usually mean a list backed by an array field).
3. Call get_api_context with those \`keywords\` (plus \`spec\` when not using the configured spec), choose the operations the page needs, then call it again with their \`operationIds\`.
4. Replace placeholder content with data through the project's existing request layer. Add loading, empty and error states.
5. Finish with a table: UI element → operation → field → evidence (which keyword, field name or example matched). List write operations (POST/PUT/PATCH/DELETE) separately for human confirmation, and list design elements with no matching field.`,
        },
      },
    ],
  }),
} as const;
