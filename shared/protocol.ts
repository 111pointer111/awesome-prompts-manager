import { z } from "zod";

export const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
export const promptSchema = z.object({
  id: identifier,
  name: z.string().min(1).max(200),
  description: z.string().max(4000),
  content: z.string().min(1).max(131072),
  defaultContent: z.string().min(1).max(131072),
  revision: z.string().min(1).max(128),
  customized: z.boolean(),
  readOnly: z.boolean(),
  maxLength: z.number().int().positive().max(131072),
  variables: z.array(z.object({ name: identifier, description: z.string().max(2000) })).max(100),
  composition: z.array(z.string().max(2000)).max(100),
  effect: z.string().min(1).max(2000),
});
export const catalogSchema = z.object({
  protocolVersion: z.literal(1),
  service: z.object({ id: identifier, name: z.string().min(1).max(200) }),
  prompts: z.array(promptSchema).max(1000),
}).superRefine((value, ctx) => {
  if (new Set(value.prompts.map(prompt => prompt.id)).size !== value.prompts.length) {
    ctx.addIssue({ code: "custom", message: "提示词 ID 重复" });
  }
});
export const updateSchema = z.object({
  content: z.string().min(1).max(131072).nullable(),
  expectedRevision: z.string().min(1).max(128),
}).strict();

export type Prompt = z.infer<typeof promptSchema>;
export type Catalog = z.infer<typeof catalogSchema>;
export type PromptUpdate = z.infer<typeof updateSchema>;

export interface Channel {
  id: string;
  name: string;
  baseUrl: string;
  serviceId: string | null;
  serviceName: string | null;
  lastSyncedAt: string | null;
  lastAttemptAt: string | null;
  error: string | null;
  syncing: boolean;
}
export interface ManagedPrompt extends Prompt {
  channelId: string;
  note: string;
  noteRevision: number;
  active: boolean;
}
export interface PlatformState {
  channels: Channel[];
  prompts: ManagedPrompt[];
}
