import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAiCompatibleInferenceClient } from "../src/portable/adapters/inference";
import { loadConfig } from "../src/portable/config";

const config = loadConfig({
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://belki:secret@localhost:5432/belki",
  APP_BASE_URL: "http://localhost:3000",
  APP_CRYPTO_KEY: "a".repeat(32),
  BOOTSTRAP_TOKEN: "b".repeat(32),
  S3_BUCKET: "belki-evidence",
  INFERENCE_MODE: "openai_compatible",
  INFERENCE_BASE_URL: "https://inference.example/v1/",
  INFERENCE_API_KEY: "secret",
  INFERENCE_MODEL: "structured-model",
});

const AnswerSchema = z.object({ answer: z.string() });

describe("OpenAI-compatible structured inference", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("validates JSON-schema output and preserves token accounting", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      model: "structured-model-2026",
      choices: [{ message: { content: JSON.stringify({ answer: "Belki" }) } }],
      usage: { prompt_tokens: 12, completion_tokens: 3 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new OpenAiCompatibleInferenceClient(config);
    await expect(client.generate({
      name: "answer",
      prompt: "Return the product name.",
      schema: AnswerSchema,
      jsonSchema: {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
        additionalProperties: false,
      },
    })).resolves.toEqual({
      value: { answer: "Belki" },
      model: "structured-model-2026",
      inputTokens: 12,
      outputTokens: 3,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://inference.example/v1/chat/completions",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("rejects malformed structured output", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ answer: 42 }) } }],
    }), { status: 200 })));
    const client = new OpenAiCompatibleInferenceClient(config);
    await expect(client.generate({
      name: "answer",
      prompt: "Return the product name.",
      schema: AnswerSchema,
      jsonSchema: { type: "object" },
    })).rejects.toThrow("structured_inference_response_invalid");
  });
});
