// The model ego runs on: Anthropic directly (ANTHROPIC_API_KEY), model from EGO_MODEL. A test gives pi-ai's faux
// provider instead.
import { createModels, type Models } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import type { ModelRef } from "@earendil-works/pi-durable";

export interface ModelChoice {
    readonly models: Models;
    readonly model: ModelRef;
}

export const anthropic = (modelId = process.env.EGO_MODEL ?? "claude-sonnet-5-5"): ModelChoice => {
    const models = createModels();

    models.setProvider(anthropicProvider());

    return { models, model: { provider: "anthropic", modelId } };
};
