// Optional AI copywriter: Claude writes click-worthy (not clickbait-y) titles, a
// description and tags from the creator's notes. Uses the creator's own API key,
// which never leaves their machine except to call the Anthropic API.
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

const Suggestion = z.object({
  titles: z.array(z.string()).describe("5 distinct title options, each under 70 characters"),
  description: z.string().describe("YouTube description body (no chapters, no hashtags), 2-4 short paragraphs"),
  tags: z.array(z.string()).describe("15-25 search tags, most specific first"),
  thumbnailText: z.string().describe("2-4 word, high-impact thumbnail caption"),
});

export type AiSuggestion = z.infer<typeof Suggestion>;

export async function suggestMetadata(
  apiKey: string,
  input: { game: string; type: string; notes: string; chapters: string[]; short: boolean; language: string },
): Promise<AiSuggestion> {
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const response = await client.messages.parse({
    model: "claude-opus-4-8",
    max_tokens: 4000,
    output_config: { format: zodOutputFormat(Suggestion) },
    system:
      "You are a YouTube gaming SEO strategist. Write metadata that ranks in YouTube search and earns clicks honestly: " +
      "lead with the game name and the most searched phrase, front-load the hook, never promise what the video does not show, " +
      "avoid ALL-CAPS spam and emoji spam. Tags mix broad (game name) and long-tail (game + mode + intent) phrases.",
    messages: [
      {
        role: "user",
        content: [
          `Game: ${input.game}`,
          `Video type: ${input.type}${input.short ? " (YouTube Short, vertical, under 3 minutes)" : ""}`,
          `Language: ${input.language}`,
          input.chapters.length ? `Chapters:\n${input.chapters.join("\n")}` : "",
          `Creator's notes about this video:\n${input.notes || "(none — infer from game and type)"}`,
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
    ],
  });
  if (!response.parsed_output) throw new Error(response.stop_reason === "refusal" ? "The request was declined" : "No suggestion returned");
  return response.parsed_output;
}
