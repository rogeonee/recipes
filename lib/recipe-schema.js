import { z } from 'zod';

export const RecipeSchema = z.object({
  title: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  image: z.string().optional().nullable(),
  author: z.string().optional().nullable(),
  yield: z.object({
    servings: z.number().optional().nullable(),
    original: z.string().optional().nullable(),
  }),
  time: z.object({
    prep: z.number().optional().nullable(), // minutes
    cook: z.number().optional().nullable(), // minutes
    total: z.number().optional().nullable(), // minutes
  }),
  ingredients: z.array(
    z.object({
      original: z.string(),
      quantity: z.number().optional().nullable(),
      unit: z.string().optional().nullable(),
      item: z.string().optional().nullable(),
      note: z.string().optional().nullable(),
    }),
  ),
  steps: z.array(
    z.object({
      n: z.number(),
      text: z.string(),
    }),
  ),
  tags: z.array(z.string()),
  dietFlags: z
    .object({
      vegan: z.boolean().optional(),
      vegetarian: z.boolean().optional(),
      glutenFree: z.boolean().optional(),
      dairyFree: z.boolean().optional(),
    })
    .partial(),
  units: z.enum(['metric', 'us']).optional().default('metric'),
  source: z.object({
    url: z.string(),
    domain: z.string().optional(),
    fetchedAt: z.string(),
  }),
  llmNotes: z.any().optional().nullable(),
});
