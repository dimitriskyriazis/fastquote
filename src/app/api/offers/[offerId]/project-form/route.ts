import { NextRequest, NextResponse } from 'next/server';
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
// Body: multipart/form-data with `file` = the blank TELMACO project form (.docx).
// Returns the same document filled with the offer's data, as a download.
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

    const formData = await req.formData();
    const file = formData.get('file');
    if (!(file instanceof File)) {
      return NextResponse.json({ ok: false, error: 'No file uploaded' }, { status: 400 });
    }
    if (!file.name.toLowerCase().endsWith('.docx')) {
      return NextResponse.json(
        { ok: false, error: 'Please upload a Word (.docx) template' },
        { status: 400 },
      );
    }

    const templateBuffer = Buffer.from(await file.arrayBuffer());
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

    let result;
    try {
      result = await fillProjectForm(templateBuffer, data);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to read the uploaded document';
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
