import type { Readable } from "node:stream";
import type { QueryResult, QueryResultRow } from "pg";
import type { z } from "zod";

export interface QueryExecutor {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
}

export interface Database extends QueryExecutor {
  transaction<T>(operation: (database: QueryExecutor) => Promise<T>): Promise<T>;
  check(): Promise<void>;
  close(): Promise<void>;
}

export interface JobOptions {
  runAt?: Date;
  priority?: number;
  maxAttempts?: number;
  queueName?: string;
  jobKey?: string;
  jobKeyMode?: "replace" | "preserve_run_at" | "unsafe_dedupe";
}

export interface JobDispatcher {
  dispatch(task: string, payload: unknown, options?: JobOptions): Promise<string>;
  check(): Promise<void>;
  close(): Promise<void>;
}

export type ObjectBody = Readable | Uint8Array | string;

export interface ObjectPutOptions {
  contentType?: string;
  contentEncoding?: string;
  metadata?: Record<string, string>;
}

export interface StoredObject {
  body: ReadableStream<Uint8Array>;
  contentType?: string;
  contentEncoding?: string;
  metadata: Record<string, string>;
}

export interface ObjectStore {
  put(key: string, body: ObjectBody, options?: ObjectPutOptions): Promise<void>;
  get(key: string): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
  check(): Promise<void>;
}

export interface StructuredInferenceRequest<T> {
  system?: string;
  prompt: string;
  name: string;
  schema: z.ZodType<T>;
  jsonSchema: Record<string, unknown>;
}

export interface StructuredInferenceResult<T> {
  value: T;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface StructuredInferenceClient {
  generate<T>(request: StructuredInferenceRequest<T>): Promise<StructuredInferenceResult<T>>;
  check(): Promise<void>;
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface EmailSender {
  readonly configured: boolean;
  send(message: EmailMessage): Promise<void>;
  check(): Promise<void>;
}

export interface OperatorPrincipal {
  email: string;
}

export interface OperatorIdentity {
  authenticate(headers: Headers): Promise<OperatorPrincipal | null>;
  check(): Promise<void>;
}
