import { NextRequest, NextResponse } from 'next/server';
import fs from 'node:fs/promises';
import { logRequest } from '../../../../../lib/apiHelpers';
import { requirePermission } from '../../../../../lib/authz';
import {
  getProjectFormData,
  getMissingRequiredFields,
} from '../../../../../lib/projectForm/projectFormData';
import { fillProjectForm } from '../../../../../lib/projectForm/fillProjectForm';

export const runtime = 'nodejs';

const DOCX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// The blank TELMACO project form lives on the file server. Its absolute path is
// configured via PROJECT_FORM_TEMPLATE_PATH (set it in your environment, e.g.
// .env.local) so the location is never hard-coded in the app.
const requireProjectFormTemplatePath = (): string => {
  const raw = process.env.PROJECT_FORM_TEMPLATE_PATH;
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) {
    throw new Error(
      'Missing PROJECT_FORM_TEMPLATE_PATH. Set it in your environment (e.g. .env.local) to the absolute path of the blank project form (.docx).',
    );
  }
  return value;
};

const parseOfferId = (raw: string): number | null => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
};

// GET /api/offers/[offerId]/project-form
// Returns the list of required Basic Data fields that are still missing, so the
// UI can point them out before the user picks a template file.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ offerId: string }> },
) {
  logRequest(req, '/api/offers/[offerId]/project-form');
  try {
    const auth = await requirePermission(req, 'editOffers');
    if (!auth.ok) return auth.response;

    const { offerId } = await params;
    const numericId = parseOfferId(offerId);
    if (numericId == null) {
      return NextResponse.json({ ok: false, error: 'Invalid offer ID' }, { status: 400 });
    }

    const data = await getProjectFormData(numericId);
    return NextResponse.json({ ok: true, missing: getMissingRequiredFields(data) });
  } catch (err) {
    console.error('project-form validation failed', err);
    return NextResponse.json(
      { ok: false, error: 'Failed to validate the offer' },
      { status: 500 },
    );
  }
}

// POST /api/offers/[offerId]/project-form
// Reads the blank TELMACO project form from the file server, fills it with the
// offer's data and returns it as a download. No request body is needed.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ offerId: string }> },
) {
  logRequest(req, '/api/offers/[offerId]/project-form');
  try {
    const auth = await requirePermission(req, 'editOffers');
    if (!auth.ok) return auth.response;

    const { offerId } = await params;
    const numericId = parseOfferId(offerId);
    if (numericId == null) {
      return NextResponse.json({ ok: false, error: 'Invalid offer ID' }, { status: 400 });
    }

    const data = await getProjectFormData(numericId);

    // Guard against missing Basic Data (defence in depth — the UI checks first).
    const missing = getMissingRequiredFields(data);
    if (missing.length > 0) {
      return NextResponse.json(
        {
          ok: false,
          error: `Required Basic Data fields are missing: ${missing.map((m) => m.label).join(', ')}.`,
          missing,
        },
        { status: 400 },
      );
    }

    let templateBuffer: Buffer;
    try {
      const templatePath = requireProjectFormTemplatePath();
      templateBuffer = await fs.readFile(templatePath);
    } catch (err) {
      console.error('project-form template read failed', err);
      return NextResponse.json(
        { ok: false, error: 'Could not open the blank project form template on the file server.' },
        { status: 500 },
      );
    }

    let result;
    try {
      result = await fillProjectForm(templateBuffer, data);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to read the project form template';
      return NextResponse.json({ ok: false, error: message }, { status: 400 });
    }

    const safeName = (data.erpProjectCode || String(numericId)).replace(/[^\w.-]+/g, '_');
    return new NextResponse(new Uint8Array(result.buffer), {
      status: 200,
      headers: {
        'Content-Type': DOCX_CONTENT_TYPE,
        'Content-Disposition': `attachment; filename="ProjectForm_${safeName}.docx"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    console.error('project-form generation failed', err);
    return NextResponse.json(
      { ok: false, error: 'Failed to generate the project form' },
      { status: 500 },
    );
  }
}
