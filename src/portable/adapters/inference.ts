import type { PortableConfig } from "../config";
import type {
  StructuredInferenceClient,
  StructuredInferenceRequest,
  StructuredInferenceResult,
} from "../contracts";

interface CompletionPayload {
  model?: string;
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

export class DisabledInferenceClient implements StructuredInferenceClient {
  generate<T>(): Promise<StructuredInferenceResult<T>> {
    return Promise.reject(new Error("structured_inference_not_configured"));
  }

  check(): Promise<void> {
    return Promise.resolve();
  }
}

export class OpenAiCompatibleInferenceClient implements StructuredInferenceClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly model: string;

  constructor(config: PortableConfig) {
    if (!config.INFERENCE_BASE_URL || !config.INFERENCE_MODEL) {
      throw new Error("Inference configuration was not validated.");
    }
    this.baseUrl = config.INFERENCE_BASE_URL.replace(/\/$/u, "");
    this.apiKey = config.INFERENCE_API_KEY;
    this.model = config.INFERENCE_MODEL;
  }

  async generate<T>(
    request: StructuredInferenceRequest<T>,
  ): Promise<StructuredInferenceResult<T>> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          ...(request.system ? [{ role: "system", content: request.system }] : []),
          { role: "user", content: request.prompt },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: request.name,
            strict: true,
            schema: request.jsonSchema,
          },
        },
      }),
    });
    const payload = await response.json().catch(() => null) as CompletionPayload | null;
    if (!response.ok) {
      throw new Error(`structured_inference_request_failed:${response.status}`);
    }
    const content = payload?.choices?.[0]?.message?.content;
    if (!content) throw new Error("structured_inference_response_missing_content");
    const parsed = request.schema.safeParse(JSON.parse(content) as unknown);
    if (!parsed.success) throw new Error("structured_inference_response_invalid");
    return {
      value: parsed.data,
      model: payload?.model ?? this.model,
      inputTokens: payload?.usage?.prompt_tokens ?? null,
      outputTokens: payload?.usage?.completion_tokens ?? null,
    };
  }

  check(): Promise<void> {
    return Promise.resolve();
  }
}

export function createInferenceClient(config: PortableConfig): StructuredInferenceClient {
  return config.INFERENCE_MODE === "openai_compatible"
    ? new OpenAiCompatibleInferenceClient(config)
    : new DisabledInferenceClient();
}
