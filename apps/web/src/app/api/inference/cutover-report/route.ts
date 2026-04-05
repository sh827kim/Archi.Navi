import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getDb } from '@archi-navi/db';
import {
  buildIntentProofCutoverReport,
  getInferenceRunDetail,
  type IntentProofCutoverArtifact,
  type IntentProofCutoverMetadata,
  type IntentProofCutoverThresholds,
  type IntentProofCutoverTruthCorpus,
} from '@archi-navi/inference';

const relationSchema = z.object({
  subject: z.string().min(1),
  relationType: z.string().min(1),
  object: z.string().min(1),
});

const frontierSchema = z.object({
  key: z.string().min(1),
  recoverable: z.boolean(),
  recovered: z.boolean(),
});

const artifactSchema = z.object({
  label: z.string().min(1),
  relations: z.array(relationSchema),
  frontiers: z.array(frontierSchema).optional(),
  approvalCount: z.number().int().min(0).optional(),
  failedChecks: z.array(z.string()).optional(),
});

const truthSchema = z.object({
  relations: z.array(relationSchema),
});

const metadataSchema = z.object({
  commitSha: z.string().min(1),
  corpusRef: z.string().min(1),
  baselineCommand: z.string().min(1),
  candidateCommand: z.string().min(1),
  baselineArtifactPath: z.string().min(1),
  candidateArtifactPath: z.string().min(1),
});

const thresholdsSchema = z.object({
  minPrecisionDelta: z.number().min(-1).max(1).optional(),
  minRecallDelta: z.number().min(-1).max(1).optional(),
  minCandidateFrontierRecoverability: z.number().min(0).max(1).optional(),
  maxApprovalCountDelta: z.number().int().optional(),
});

const requestSchema = z.object({
  baseline: artifactSchema,
  candidate: artifactSchema,
  truth: truthSchema,
  metadata: metadataSchema,
  thresholds: thresholdsSchema.optional(),
});

const runBackedRequestSchema = z.object({
  workspaceId: z.string().min(1),
  baselineRunId: z.string().min(1),
  candidateRunId: z.string().min(1),
  truth: truthSchema,
  metadata: metadataSchema,
  thresholds: thresholdsSchema.optional(),
});

function authorizeCutoverReportRequest(req: NextRequest): NextResponse | null {
  const expectedToken = process.env['INFERENCE_RUNS_API_TOKEN']?.trim();
  if (!expectedToken) {
    console.error('[inference/cutover-report] INFERENCE_RUNS_API_TOKEN is not configured');
    return NextResponse.json({ error: 'Inference run API is not configured' }, { status: 503 });
  }

  const authorization = req.headers.get('authorization');
  const bearerMatch = authorization?.match(/^Bearer\s+(.+)$/i);
  const bearerToken = bearerMatch?.[1]?.trim() ?? null;
  const headerToken = req.headers.get('x-inference-runs-token')?.trim();
  const providedToken = bearerToken ?? headerToken;

  if (!providedToken || providedToken !== expectedToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return null;
}

function readCutoverArtifact(run: { stats: unknown }, runId: string): IntentProofCutoverArtifact {
  const stats =
    run.stats && typeof run.stats === 'object' && !Array.isArray(run.stats)
      ? run.stats as Record<string, unknown>
      : {};
  const artifact = stats['cutoverArtifact'];
  const parsed = artifactSchema.safeParse(artifact);
  if (!parsed.success) {
    throw new Error(`cutover artifact is not available for run ${runId}`);
  }
  return parsed.data as IntentProofCutoverArtifact;
}

export async function POST(req: NextRequest) {
  try {
    const authError = authorizeCutoverReportRequest(req);
    if (authError) return authError;

    const json = await req.json();
    const parsedInline = requestSchema.safeParse(json);
    if (parsedInline.success) {
      const body = parsedInline.data as {
        baseline: IntentProofCutoverArtifact;
        candidate: IntentProofCutoverArtifact;
        truth: IntentProofCutoverTruthCorpus;
        metadata: IntentProofCutoverMetadata;
        thresholds?: IntentProofCutoverThresholds;
      };

      const report = buildIntentProofCutoverReport(body);
      return NextResponse.json({ ok: true, report });
    }

    const parsedRunBacked = runBackedRequestSchema.safeParse(json);
    if (!parsedRunBacked.success) {
      return NextResponse.json(
        {
          error: 'Invalid request body',
          details: {
            inline: parsedInline.error.flatten(),
            runBacked: parsedRunBacked.error.flatten(),
          },
        },
        { status: 400 },
      );
    }

    const db = await getDb();
    const body = parsedRunBacked.data as {
      workspaceId: string;
      baselineRunId: string;
      candidateRunId: string;
      truth: IntentProofCutoverTruthCorpus;
      metadata: IntentProofCutoverMetadata;
      thresholds?: IntentProofCutoverThresholds;
    };

    const [baselineDetail, candidateDetail] = await Promise.all([
      getInferenceRunDetail(db, { workspaceId: body.workspaceId, runId: body.baselineRunId }),
      getInferenceRunDetail(db, { workspaceId: body.workspaceId, runId: body.candidateRunId }),
    ]);

    const report = buildIntentProofCutoverReport({
      baseline: readCutoverArtifact(baselineDetail.run, body.baselineRunId),
      candidate: readCutoverArtifact(candidateDetail.run, body.candidateRunId),
      truth: body.truth,
      metadata: body.metadata,
      ...(body.thresholds ? { thresholds: body.thresholds } : {}),
    });
    return NextResponse.json({ ok: true, report });
  } catch (error) {
    console.error('[POST /api/inference/cutover-report]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
