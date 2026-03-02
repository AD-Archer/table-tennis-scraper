import { NextResponse } from "next/server";
import { getWTTPipelineStatusFull } from "@/lib/pipeline/wtt-detector";

export async function GET() {
  try {
    const pipeline = await getWTTPipelineStatusFull();
    return NextResponse.json({ ok: true, pipeline });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "unknown error",
      },
      { status: 500 },
    );
  }
}
