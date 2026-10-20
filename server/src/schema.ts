import { z } from 'zod';
import { SIGNIFICANCES, TONES } from '../../shared/types.ts';

const text = (max: number) => z.string().trim().min(1).max(max);
const significance = z.enum(SIGNIFICANCES);
const tone = z.enum(TONES);

export const generatedNode = z.object({
  title: text(140),
  period: text(80),
  summary: text(800),
  narrative: text(8000),
  keyChanges: z.array(text(300)).min(1).max(10),
  significance,
  tone,
  likelihood: z.number().gt(0).lte(1).optional(),
});

export const continueResult = z
  .object({
    children: z.array(generatedNode).min(1).max(4),
    branchReason: z.string().trim().max(600).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.children.length < 2) return;
    if (!val.branchReason) {
      ctx.addIssue({ code: 'custom', path: ['branchReason'], message: 'required when returning 2-4 children' });
    }
    val.children.forEach((c, i) => {
      if (c.likelihood === undefined) {
        ctx.addIssue({ code: 'custom', path: ['children', i, 'likelihood'], message: 'required when branching' });
      }
    });
  });

export const regenerateResult = z.object({ node: generatedNode.omit({ likelihood: true }) });

export const deviationInput = z.object({
  title: text(140),
  period: z.string().trim().max(80).default(''),
  summary: text(2000),
  narrative: z.string().trim().max(8000).default(''),
  significance: significance.default('pivotal'),
  tone: tone.default('neutral'),
});

export const nodeEdit = z.object({
  title: text(140).optional(),
  period: z.string().trim().max(80).optional(),
  summary: z.string().trim().max(2000).optional(),
  narrative: z.string().trim().max(8000).optional(),
  keyChanges: z.array(z.string().trim().min(1).max(300)).max(15).optional(),
  significance: significance.optional(),
  tone: tone.optional(),
});

export const generateOptions = z.object({
  timeSpan: z.string().trim().max(80).optional(),
  guidance: z.string().trim().max(1000).optional(),
});

export function formatIssues(err: z.ZodError): string {
  return err.issues.map((i) => `- ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
}
